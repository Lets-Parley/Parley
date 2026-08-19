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
	_, err := loadMigrations(fsys)
	if err == nil || !strings.Contains(err.Error(), "non-numeric version prefix") {
		t.Fatalf("expected a non-numeric prefix to be rejected, got: %v", err)
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

// TestLoadMigrationsRejectsSignedPrefixes pins the strings.ContainsAny(prefix,
// "+-") clause. strconv.Atoi accepts a sign, so "+0005" and "-0005" parse as 5
// and -5: without the clause "+0005_x.sql" would silently claim version 5 and
// collide with the real 0005_*.sql, against the purely-numeric rule in
// CONTRIBUTING.md.
func TestLoadMigrationsRejectsSignedPrefixes(t *testing.T) {
	for _, name := range []string{"+0005_x.sql", "-0005_x.sql"} {
		t.Run(name, func(t *testing.T) {
			fsys := fstest.MapFS{
				"migrations/0005_real.sql": {Data: []byte("real")},
				"migrations/" + name:       {Data: []byte("x")},
			}
			_, err := loadMigrations(fsys)
			if err == nil || !strings.Contains(err.Error(), "non-numeric version prefix") {
				t.Fatalf("expected %s to be rejected as non-numeric, got: %v", name, err)
			}
		})
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

// migrationLockBackends counts the backends the migration lock connection
// opens. Scoped to this database AND this user on purpose: pg_stat_activity is
// cluster-wide, so an unscoped count would tally other databases' sessions and
// pass — or flake — for reasons that have nothing to do with Parley. The
// application_name is set explicitly by withMigrationLock, because pgx leaves
// it empty by default and a filter on an empty name matches everything.
func migrationLockBackends(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`select count(*) from pg_stat_activity
		  where application_name = $1
		    and datname = current_database()
		    and usename = current_user
		    and pid <> pg_backend_pid()`, migrationLockAppName).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestMigrateClosesTheLockConnection pins the deferred Close in
// withMigrationLock. The explicit pg_advisory_unlock already keeps the lock
// free, so lock-freedom assertions pass even when the dedicated connection is
// never closed: without this test, deleting the Close leaks one backend per
// call and nothing notices.
//
// In production Migrate runs once per boot, so the leak would be one
// connection per pod start — this is a coverage guarantee, not an outage fix.
func TestMigrateClosesTheLockConnection(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// The sanity check that keeps this test from passing vacuously: the filter
	// must be able to see the backend while it exists.
	seen := 0
	if err := withMigrationLock(ctx, pool, func() error {
		seen = migrationLockBackends(t, pool)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if seen < 1 {
		t.Fatal("saw no migration-lock backend while the lock was held: the filter cannot see what it is meant to count")
	}

	for i := 0; i < 3; i++ {
		if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
			t.Fatal(err)
		}
	}

	// Close is asynchronous from the server's point of view, so give the
	// backends a moment to go away before declaring them leaked.
	var left int
	deadline := time.Now().Add(10 * time.Second)
	for {
		left = migrationLockBackends(t, pool)
		if left == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if left != 0 {
		t.Fatalf("%d migration-lock connections outlived Migrate: the dedicated connection is leaking, one per call", left)
	}
}

// TestMigrationLockSurvivesACancelledContext pins the closeCtx in the deferred
// release. That context is derived from context.Background() rather than the
// caller's ctx because the explicit pg_advisory_unlock is a query, and a query
// on a cancelled context never reaches the server. Closing the socket would
// still end the session and drop the lock with it, so the swap is invisible to
// a lock-freedom assertion — it shows up only as the unlock silently failing
// on every cancelled boot, which is why this test watches for that warning.
func TestMigrationLockSurvivesACancelledContext(t *testing.T) {
	pool := testPool(t)

	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(prev)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Cancel after the lock is taken but before the work returns, which is what
	// a pod killed mid-migration looks like.
	err := withMigrationLock(ctx, pool, func() error {
		cancel()
		return ctx.Err()
	})
	if err == nil {
		t.Fatal("expected the cancelled work to return an error")
	}
	if logged := buf.String(); strings.Contains(logged, "could not release the migration lock explicitly") {
		t.Fatalf("the explicit unlock failed under a cancelled context: the release path is using the caller's context, not one derived from Background\n%s", logged)
	}

	// And the lock really is free — asked from a different session, because
	// advisory locks are re-entrant within the session that holds them, so
	// asking the holder proves nothing.
	free := false
	deadline := time.Now().Add(10 * time.Second)
	for !free && time.Now().Before(deadline) {
		if free = tryMigrationLock(t, pool); !free {
			time.Sleep(50 * time.Millisecond)
		}
	}
	if !free {
		t.Fatal("the migration lock is still held after a cancelled context")
	}
	if left := migrationLockBackends(t, pool); left != 0 {
		t.Fatalf("%d migration-lock connections survived a cancelled context", left)
	}
}

// TestMigrationLockIDIsNotTheRetiredBootLockID is this epic's documented
// landmine, and today only a code comment guards it.
//
// 0x7061726c6579 was AcquireBootLock's id, held for the whole process
// lifetime. Migrate now takes a *blocking* pg_advisory_lock; on an id the
// process already holds elsewhere, that deadlocks every pod against itself, on
// every boot, forever. The value must never be reused for any lock this
// process takes while running.
func TestMigrationLockIDIsNotTheRetiredBootLockID(t *testing.T) {
	const retiredBootLockID int64 = 0x7061726c6579
	if migrationLockID == retiredBootLockID {
		t.Fatalf("migrationLockID is the retired boot lock id %#x; a blocking lock on it deadlocks every boot", retiredBootLockID)
	}
}

// TestLoadMigrationsRejectsDuplicateVersions: two files claiming the same
// version is a numbering collision from two branches merging. Only one of them
// would ever be applied, and the other would be silently skipped forever, so
// this has to be a loud boot refusal rather than a coin flip.
func TestLoadMigrationsRejectsDuplicateVersions(t *testing.T) {
	fsys := fstest.MapFS{
		"migrations/0001_a.sql": {Data: []byte("a")},
		"migrations/0001_b.sql": {Data: []byte("b")},
	}
	_, err := loadMigrations(fsys)
	if err == nil {
		t.Fatal("expected two migrations sharing version 1 to be rejected")
	}
	if !strings.Contains(err.Error(), "share version 1") {
		t.Fatalf("expected the error to name the collision, got: %v", err)
	}
}
