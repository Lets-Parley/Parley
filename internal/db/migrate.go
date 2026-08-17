package db

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	files := make([]string, 0, len(entries))
	for _, e := range entries {
		files = append(files, e.Name())
	}
	sort.Strings(files)

	if _, err := pool.Exec(ctx,
		"create table if not exists migrations (version int primary key, name text not null, applied_at timestamptz not null default now())",
	); err != nil {
		return fmt.Errorf("creating migrations table: %w", err)
	}

	var current int
	if err := pool.QueryRow(ctx, "select coalesce(max(version), 0) from migrations").Scan(&current); err != nil {
		return err
	}

	if current > len(files) {
		return fmt.Errorf("database schema is at version %d but this binary only knows %d migrations — the database is newer than this image; restore from backup or use an image at or above the version that wrote it", current, len(files))
	}

	for i, name := range files {
		version := i + 1
		if version <= current {
			continue
		}
		sql, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %d (%s) failed: %w", version, name, err)
		}
		if _, err := tx.Exec(ctx, "insert into migrations (version, name) values ($1, $2)", version, name); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("recording migration %d (%s): %w", version, name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("committing migration %d (%s): %w", version, name, err)
		}
		log.Info("applied migration", "version", version, "name", name)
	}
	return nil
}
