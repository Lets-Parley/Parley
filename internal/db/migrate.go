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

	"github.com/jackc/pgx/v5/pgxpool"
)

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

// Migrate applies every migration in fsys that the database has not yet seen.
// Migrations are forward-only: there is no down path, so back up the database
// before upgrading.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, fsys fs.FS) error {
	migrations, err := loadMigrations(fsys)
	if err != nil {
		return err
	}

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
