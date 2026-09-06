package db

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestSessionTokensSweepIndexesExist is the install path: after a full
// migrate, session_tokens has btree indexes on the three columns the hourly
// sweep filters by. Without them every pass sequentially scans the heap.
func TestSessionTokensSweepIndexesExist(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), MigrationsFS); err != nil {
		t.Fatalf("migrating: %v", err)
	}

	want := []struct {
		name   string
		defSub string
	}{
		{"session_tokens_last_used_at_idx", "using btree (last_used_at)"},
		{"session_tokens_created_at_idx", "using btree (created_at)"},
		{"session_tokens_expires_at_idx", "using btree (expires_at) where"},
	}
	for _, idx := range want {
		var def string
		err := pool.QueryRow(ctx, `
			select indexdef from pg_indexes
			where tablename = 'session_tokens' and indexname = $1`, idx.name,
		).Scan(&def)
		if err != nil {
			t.Fatalf("%s missing after migrate: %v", idx.name, err)
		}
		lower := strings.ToLower(def)
		if !strings.Contains(lower, idx.defSub) {
			t.Fatalf("%s must be %s; got %s", idx.name, idx.defSub, def)
		}
	}

	var expiresDef string
	if err := pool.QueryRow(ctx, `
		select indexdef from pg_indexes
		where indexname = 'session_tokens_expires_at_idx'`).Scan(&expiresDef); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(expiresDef), "expires_at is not null") {
		t.Fatalf("expires_at index must be partial on expires_at is not null; got %s", expiresDef)
	}
}

// TestSessionTokensSweepQueryUsesIndexes seeds enough token rows that the
// planner leaves a sequential scan behind, then checks EXPLAIN ANALYZE of the
// sweep's inner select for an index or bitmap scan.
func TestSessionTokensSweepQueryUsesIndexes(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), MigrationsFS); err != nil {
		t.Fatalf("migrating: %v", err)
	}

	var userID string
	if err := pool.QueryRow(ctx,
		"insert into users (name) values ('sweep-idx') returning id",
	).Scan(&userID); err != nil {
		t.Fatal(err)
	}

	// Live rows plus a minority that each arm of the OR can match, so the
	// planner has a reason to probe the three indexes rather than scan.
	if _, err := pool.Exec(ctx, `
		insert into session_tokens (token_hash, user_id, created_at, last_used_at, expires_at)
		select
			decode(lpad(to_hex(g), 64, '0'), 'hex'),
			$1,
			now() - interval '1 day',
			now() - interval '1 hour',
			null
		from generate_series(1, 8000) g`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into session_tokens (token_hash, user_id, created_at, last_used_at, expires_at)
		select
			decode(lpad(to_hex(g + 10000), 64, '0'), 'hex'),
			$1,
			now() - interval '100 days',
			now() - interval '1 hour',
			null
		from generate_series(1, 400) g`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into session_tokens (token_hash, user_id, created_at, last_used_at, expires_at)
		select
			decode(lpad(to_hex(g + 20000), 64, '0'), 'hex'),
			$1,
			now() - interval '1 day',
			now() - interval '100 days',
			null
		from generate_series(1, 400) g`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into session_tokens (token_hash, user_id, created_at, last_used_at, expires_at)
		select
			decode(lpad(to_hex(g + 30000), 64, '0'), 'hex'),
			$1,
			now() - interval '1 day',
			now() - interval '1 hour',
			now() - interval '1 minute'
		from generate_series(1, 400) g`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "analyze session_tokens"); err != nil {
		t.Fatal(err)
	}

	plan := explainAnalyzeSweepSelect(t, pool)
	t.Logf("sweep select plan:\n%s", plan)
	lower := strings.ToLower(plan)
	if strings.Contains(lower, "seq scan") {
		t.Fatalf("sweep select used a sequential scan;\n%s", plan)
	}
	usesIndex := strings.Contains(lower, "index scan") ||
		strings.Contains(lower, "bitmap index scan") ||
		strings.Contains(lower, "bitmap heap scan")
	if !usesIndex {
		t.Fatalf("sweep select must use an index or bitmap scan;\n%s", plan)
	}
	named := strings.Contains(plan, "session_tokens_last_used_at_idx") ||
		strings.Contains(plan, "session_tokens_created_at_idx") ||
		strings.Contains(plan, "session_tokens_expires_at_idx")
	if !named {
		t.Fatalf("sweep select must name a sweep index;\n%s", plan)
	}
}

func explainAnalyzeSweepSelect(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	return explainAnalyzeText(t, pool, `
		select ctid from session_tokens
		where last_used_at <= now() - $1::interval
		   or created_at <= now() - $2::interval
		   or (expires_at is not null and expires_at <= now())
		limit $3`,
		"2160h", "2160h", 1000)
}

func explainAnalyzeText(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, "explain (analyze, buffers) "+sql, args...)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return b.String()
}
