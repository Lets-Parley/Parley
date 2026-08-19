package db

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := dbtest.DSN(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestMigrateAppliesAndIsIdempotent(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	pool.Exec(ctx, "drop schema public cascade; create schema public")
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatalf("second run should be a no-op: %v", err)
	}
}

func TestMigrateRefusesNewerDatabase(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	pool.Exec(ctx, "drop schema public cascade; create schema public")
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into migrations (version, name) values (99, 'from-the-future')"); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, "delete from migrations where version = 99")

	err := Migrate(ctx, pool, log, MigrationsFS)
	if err == nil || !strings.Contains(err.Error(), "newer than this image") {
		t.Fatalf("expected newer-database refusal, got: %v", err)
	}
}

func TestLoadMigrationsUsesFilenamePrefix(t *testing.T) {
	fsys := fstest.MapFS{
		"migrations/0001_a.sql":  {Data: []byte("a")},
		"migrations/0002_b.sql":  {Data: []byte("b")},
		"migrations/0010_c.sql":  {Data: []byte("c")},
		"migrations/0003a_x.sql": nil,
	}
	if _, err := loadMigrations(fsys); err == nil {
		t.Fatal("expected a non-numeric prefix to be rejected")
	}

	delete(fsys, "migrations/0003a_x.sql")
	before, err := loadMigrations(fsys)
	if err != nil {
		t.Fatal(err)
	}
	// A mid-sequence insertion must not renumber anything after it.
	fsys["migrations/0005_inserted.sql"] = &fstest.MapFile{Data: []byte("i")}
	after, err := loadMigrations(fsys)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, m := range after {
		got[m.name] = m.version
	}
	for _, m := range before {
		if got[m.name] != m.version {
			t.Fatalf("%s renumbered from %d to %d", m.name, m.version, got[m.name])
		}
	}
	if got["0005_inserted.sql"] != 5 || got["0010_c.sql"] != 10 {
		t.Fatalf("versions not derived from prefix: %v", got)
	}
	for i := 1; i < len(after); i++ {
		if after[i-1].version >= after[i].version {
			t.Fatalf("migrations out of ascending order: %v", after)
		}
	}
}

func TestShippedMigrationVersionsAreUnique(t *testing.T) {
	if _, err := loadMigrations(MigrationsFS); err != nil {
		t.Fatal(err)
	}
}

// tryMigrationLock reports whether the migration advisory lock is free. It
// takes and immediately releases it on a connection of its own, so a leaked
// lock from a previous Migrate shows up as false.
func tryMigrationLock(t *testing.T, pool *pgxpool.Pool) bool {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, "select pg_try_advisory_lock($1)", migrationLockID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got {
		if _, err := conn.Exec(ctx, "select pg_advisory_unlock($1)", migrationLockID); err != nil {
			t.Fatal(err)
		}
	}
	return got
}

// TestMigrateIsSafeWhenReplicasStartTogether is the multi-replica case: several
// pods boot at once and every one of them runs Migrate against the same fresh
// database. All must succeed, and each migration must be recorded exactly once.
func TestMigrateConcurrentReplicas(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}

	const replicas = 6
	// Each "replica" gets its own pool, the way separate processes would.
	pools := make([]*pgxpool.Pool, replicas)
	for i := range pools {
		pools[i] = testPool(t)
	}

	start := make(chan struct{})
	errs := make(chan error, replicas)
	var wg sync.WaitGroup
	for i := 0; i < replicas; i++ {
		wg.Add(1)
		go func(p *pgxpool.Pool) {
			defer wg.Done()
			<-start
			errs <- Migrate(ctx, p, log, MigrationsFS)
		}(pools[i])
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a concurrent Migrate failed: %v", err)
		}
	}

	want, err := loadMigrations(MigrationsFS)
	if err != nil {
		t.Fatal(err)
	}
	var rows, distinct int
	if err := pool.QueryRow(ctx, "select count(*), count(distinct version) from migrations").Scan(&rows, &distinct); err != nil {
		t.Fatal(err)
	}
	if rows != len(want) || distinct != len(want) {
		t.Fatalf("expected %d migrations recorded exactly once, got %d rows / %d distinct versions", len(want), rows, distinct)
	}
	if !tryMigrationLock(t, pool) {
		t.Fatal("the migration lock is still held after every replica finished")
	}
}

// TestMigrateReleasesTheLock covers both exits. A leaked migration lock wedges
// every future boot, so the failure path matters more than the success one.
func TestMigrateReleasesTheLock(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatal(err)
	}
	if !tryMigrationLock(t, pool) {
		t.Fatal("lock still held after a successful Migrate")
	}

	// A failure taken *after* the lock is acquired: the database is newer than
	// this (deliberately truncated) set of migrations.
	short := fstest.MapFS{"migrations/0001_only.sql": &fstest.MapFile{Data: []byte("select 1")}}
	if err := Migrate(ctx, pool, log, short); err == nil {
		t.Fatal("expected the newer-database refusal")
	}
	if !tryMigrationLock(t, pool) {
		t.Fatal("lock leaked after a failed Migrate")
	}

	// And a migration whose SQL is broken, which fails mid-apply.
	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	broken := fstest.MapFS{"migrations/0001_broken.sql": &fstest.MapFile{Data: []byte("this is not sql")}}
	if err := Migrate(ctx, pool, log, broken); err == nil {
		t.Fatal("expected a broken migration to fail")
	}
	if !tryMigrationLock(t, pool) {
		t.Fatal("lock leaked after a migration failed mid-apply")
	}

	// Leave the database on the real schema for whatever runs next.
	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatal(err)
	}
}

// TestBootSequenceCompletes is the self-deadlock guard. Boot connects a pool
// and then migrates; if anything on that path ever takes a blocking advisory
// lock on an id it already holds, this hangs instead of returning.
func TestBootSequenceCompletes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	pool, err := Connect(ctx, dbtest.DSN(t), log)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	done := make(chan error, 1)
	go func() { done <- Migrate(ctx, pool, log, MigrationsFS) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("the boot sequence did not finish: something on it is deadlocked")
	}

	// A second boot against the same database, as a rolling update does.
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatal(err)
	}
	if !tryMigrationLock(t, pool) {
		t.Fatal("the migration lock is still held after boot")
	}
}
