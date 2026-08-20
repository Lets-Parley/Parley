package db

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

// standupReadyVersion is the migration under test; everything below it is the
// already-deployed world the upgrade has to land on.
const standupReadyVersion = 16

// A live database is already at 0015 with standup entries in it. Adding the
// readiness column must land on those rows without disturbing a character of
// what anybody wrote, and must leave them not-ready — nobody in a standup that
// predates the column ever signalled anything.
func TestStandupReadyUpgradesADatabaseWithExistingEntries(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	if err := Migrate(ctx, pool, log, upTo(t, standupReadyVersion-1)); err != nil {
		t.Fatalf("migrate to %d: %v", standupReadyVersion-1, err)
	}
	if _, err := pool.Exec(ctx, `
		insert into spaces (slug, name) values ('platform-team', 'Platform Team');
		insert into users (name) values ('Ada Nowak');
		insert into sessions (space_id, kind, title, config, facilitator_id)
		select s.id, 'standup', 'Daily', '{}'::jsonb, u.id from spaces s, users u;
		insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
		select se.id, u.id, 'shipped the importer', 'review queue', 'staging', 1
		from sessions se, users u;`); err != nil {
		t.Fatalf("seed pre-upgrade rows: %v", err)
	}

	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatalf("upgrade to %d: %v", standupReadyVersion, err)
	}

	var ready bool
	var yesterday, today, blockers string
	if err := pool.QueryRow(ctx,
		"select ready, yesterday, today, blockers from standup_entries",
	).Scan(&ready, &yesterday, &today, &blockers); err != nil {
		t.Fatalf("read the upgraded row: %v", err)
	}
	if ready {
		t.Error("an entry written before the column existed came out marked ready")
	}
	if yesterday != "shipped the importer" || today != "review queue" || blockers != "staging" {
		t.Errorf("the upgrade disturbed the update: %q / %q / %q", yesterday, today, blockers)
	}
}
