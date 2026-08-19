package db

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
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
