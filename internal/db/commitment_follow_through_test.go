package db

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

// followThroughVersion is the migration under test; everything below it is
// the already-deployed world the upgrade has to land on.
const followThroughVersion = 41

// A live database already holds commitments, some finished. Before the reason
// column existed the only way to finish one was to answer that it landed, so
// every closed row comes out 'landed' and every open row has no reason at all.
func TestFollowThroughBackfillsClosedCommitmentsAsLanded(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	if err := Migrate(ctx, pool, log, upTo(t, followThroughVersion-1)); err != nil {
		t.Fatalf("migrate to %d: %v", followThroughVersion-1, err)
	}
	if _, err := pool.Exec(ctx, `
		insert into spaces (slug, name) values ('platform-team', 'Platform Team');
		insert into users (name) values ('Ada Nowak');
		insert into sessions (space_id, kind, title, config, facilitator_id)
		select s.id, 'standup', 'Daily', '{}'::jsonb, u.id from spaces s, users u;
		insert into standup_commitments (space_id, user_id, text, opened_session_id, closed_at)
		select s.id, u.id, 'finished one', se.id, now() from spaces s, users u, sessions se;
		insert into standup_commitments (space_id, user_id, text, opened_session_id)
		select s.id, u.id, 'open one', se.id from spaces s, users u, sessions se;`); err != nil {
		t.Fatalf("seed pre-upgrade rows: %v", err)
	}

	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatalf("upgrade to %d: %v", followThroughVersion, err)
	}

	reasons := map[string]*string{}
	rows, err := pool.Query(ctx, "select text, closed_reason from standup_commitments")
	if err != nil {
		t.Fatalf("read the upgraded rows: %v", err)
	}
	for rows.Next() {
		var text string
		var reason *string
		if err := rows.Scan(&text, &reason); err != nil {
			t.Fatal(err)
		}
		reasons[text] = reason
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if r := reasons["finished one"]; r == nil || *r != "landed" {
		t.Errorf("a commitment closed before the column existed: reason = %v, want landed", r)
	}
	if r := reasons["open one"]; r != nil {
		t.Errorf("an open commitment was given a reason: %q", *r)
	}

	if _, err := pool.Exec(ctx,
		"update standup_commitments set closed_reason = 'forgotten' where text = 'open one'"); err == nil {
		t.Error("closed_reason accepted a value that is neither landed nor dropped")
	}
	if _, err := pool.Exec(ctx, "select 1 from standup_mentions limit 1"); err != nil {
		t.Errorf("standup_mentions is missing after the upgrade: %v", err)
	}
}
