package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// migrationLockID is the advisory lock every replica takes before migrating,
// so simultaneous boots serialize instead of racing each other's DDL.
//
// It must never collide with any other advisory lock this process takes: a
// blocking pg_advisory_lock on an id the same process already holds elsewhere
// would deadlock every pod against itself, on every boot, forever.
const migrationLockID int64 = 0x7061726c65796d

// migrationLockAppName labels the dedicated lock connection in
// pg_stat_activity, so an operator looking at a hung boot can tell the
// migration backend apart from the pool's, and so a test can prove the
// connection is closed rather than leaked.
const migrationLockAppName = "parley-migrate"

//go:embed migrations/*.sql
var migrationFS embed.FS

// MigrationsFS holds the migrations compiled into this binary.
var MigrationsFS fs.FS = migrationFS

type migration struct {
	version int
	name    string
}

// loadMigrations lists migrations/*.sql in ascending version order, where the
// version is the numeric filename prefix. Names whose prefix is not purely
// numeric are rejected: 0004a_foo.sql would otherwise parse as 4 and collide
// with 0004_sessions.sql.
func loadMigrations(fsys fs.FS) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, "migrations")
	if err != nil {
		return nil, fmt.Errorf("reading migrations directory: %w", err)
	}
	migrations := make([]migration, 0, len(entries))
	seen := map[int]string{}
	for _, e := range entries {
		name := e.Name()
		prefix, _, ok := strings.Cut(name, "_")
		if !ok {
			return nil, fmt.Errorf("migration %q has no version prefix; expected NNNN_name.sql", name)
		}
		version, err := strconv.Atoi(prefix)
		if err != nil || version <= 0 || strings.ContainsAny(prefix, "+-") {
			return nil, fmt.Errorf("migration %q has a non-numeric version prefix %q; expected NNNN_name.sql", name, prefix)
		}
		if other, dup := seen[version]; dup {
			return nil, fmt.Errorf("migrations %q and %q share version %d", other, name, version)
		}
		seen[version] = name
		migrations = append(migrations, migration{version: version, name: name})
	}
	slices.SortFunc(migrations, func(a, b migration) int { return a.version - b.version })
	return migrations, nil
}

// Migrate applies every migration in fsys that the database has not yet seen,
// holding an advisory lock so that replicas booting at the same moment
// serialize: the first one migrates and the rest wait, then find nothing to do.
//
// Migrations are forward-only: there is no down path, so back up the database
// before upgrading.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, fsys fs.FS) error {
	// Loading is pure and cheap, so a malformed migration set is rejected
	// before anyone waits on a lock for it.
	migrations, err := loadMigrations(fsys)
	if err != nil {
		return err
	}
	return withMigrationLock(ctx, pool, func() error {
		return migrate(ctx, pool, log, migrations, fsys)
	})
}

// withMigrationLock runs fn while holding a session-scoped advisory lock.
//
// The lock is session-scoped rather than transaction-scoped because each
// migration commits in its own transaction: a pg_advisory_xact_lock would be
// released by the first commit and let a second replica in halfway through.
//
// The connection is dialled outside the pool, for the same reason the session
// listener is: a pooled connection parked in a blocking pg_advisory_lock is a
// connection pool.Close() waits forever to get back, and it would also spend
// one of the pool's ten connections for the duration.
//
// Release is guaranteed on every path by the deferred Close: ending the session
// drops every advisory lock it holds, so even a failed explicit unlock, a
// panic, or a cancelled context cannot leak the lock and wedge future boots.
func withMigrationLock(ctx context.Context, pool *pgxpool.Pool, fn func() error) error {
	cfg := pool.Config().ConnConfig.Copy()
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["application_name"] = migrationLockAppName
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connecting to take the migration lock: %w", err)
	}
	defer func() {
		// Not ctx: by the time this runs ctx may be cancelled, and a query on
		// a cancelled context never reaches the server, so the explicit unlock
		// below would fail on every interrupted boot and leave the release to
		// the socket close alone.
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(closeCtx, "select pg_advisory_unlock($1)", migrationLockID); err != nil {
			slog.Warn("could not release the migration lock explicitly; closing the connection instead", "error", err)
		}
		if err := conn.Close(closeCtx); err != nil {
			slog.Warn("could not close the migration lock connection", "error", err)
		}
	}()

	// Blocking, not try: a replica that loses the race must wait for the
	// migration to finish, not fail its boot.
	if _, err := conn.Exec(ctx, "select pg_advisory_lock($1)", migrationLockID); err != nil {
		return fmt.Errorf("taking the migration lock: %w", err)
	}
	return fn()
}

func migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, migrations []migration, fsys fs.FS) error {
	if _, err := pool.Exec(ctx,
		"create table if not exists migrations (version int primary key, name text not null, applied_at timestamptz not null default now())",
	); err != nil {
		return fmt.Errorf("creating migrations table: %w", err)
	}

	var current int
	if err := pool.QueryRow(ctx, "select coalesce(max(version), 0) from migrations").Scan(&current); err != nil {
		return err
	}

	var latest int
	if len(migrations) > 0 {
		latest = migrations[len(migrations)-1].version
	}
	if current > latest {
		return fmt.Errorf("database schema is at version %d but this binary only knows up to %d — the database is newer than this image; restore from backup or use an image at or above the version that wrote it", current, latest)
	}

	for _, m := range migrations {
		if m.version <= current {
			continue
		}
		sql, err := fs.ReadFile(fsys, "migrations/"+m.name)
		if err != nil {
			return fmt.Errorf("reading migration %s: %w", m.name, err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %d (%s) failed: %w", m.version, m.name, err)
		}
		if _, err := tx.Exec(ctx, "insert into migrations (version, name) values ($1, $2)", m.version, m.name); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("recording migration %d (%s): %w", m.version, m.name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("committing migration %d (%s): %w", m.version, m.name, err)
		}
		log.Info("applied migration", "version", m.version, "name", m.name)
	}
	return nil
}
