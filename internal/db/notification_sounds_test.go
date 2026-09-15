package db

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

func TestNotificationColumnsDefaultExistingRowsOff(t *testing.T) {
	pool := scratchPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := Migrate(ctx, pool, log, upTo(t, 36)); err != nil {
		t.Fatal(err)
	}
	var userID, spaceID, sessionID string
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Ada') returning id").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into spaces (slug, name) values ('sounds', 'Sounds') returning id").Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'poker', 'Planning', '{}', $2) returning id`, spaceID, userID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatal(err)
	}
	var sounds bool
	var roundVersion int64
	if err := pool.QueryRow(ctx, "select notification_sounds from users where id = $1", userID).Scan(&sounds); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "select poker_round_version from sessions where id = $1", sessionID).Scan(&roundVersion); err != nil {
		t.Fatal(err)
	}
	if sounds || roundVersion != 0 {
		t.Fatalf("existing row defaults = sounds %v, round %d; want false, 0", sounds, roundVersion)
	}
}
