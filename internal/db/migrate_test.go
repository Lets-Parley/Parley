package db

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"

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

	pool.Exec(ctx, "drop table if exists migrations")
	if err := Migrate(ctx, pool, log); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, log); err != nil {
		t.Fatalf("second run should be a no-op: %v", err)
	}
}

func TestMigrateRefusesNewerDatabase(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	pool.Exec(ctx, "drop table if exists migrations")
	if err := Migrate(ctx, pool, log); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into migrations (version, name) values (99, 'from-the-future')"); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, "delete from migrations where version = 99")

	err := Migrate(ctx, pool, log)
	if err == nil || !strings.Contains(err.Error(), "newer than this image") {
		t.Fatalf("expected newer-database refusal, got: %v", err)
	}
}
