package store

import (
	"context"
	"testing"
	"time"
)

// The front page marks each space with whether a round is open and how many
// are sitting at it, from the same list query. "Here" must mean what the room
// itself means by it — the presence window — so an ended round and a row
// nobody has refreshed are not counted.
func TestForUserReportsOpenRoundsAndWhoIsHere(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	spaces := &Spaces{Pool: pool}
	sessions := &Sessions{Pool: pool}
	window := time.Minute
	p := &Presence{Pool: pool, ReplicaID: "r1", Window: window}

	busy, owner := newSpaceWithCreator(t, pool)
	guest, _ := newUser(t, pool, "Guest "+randSuffix(t))
	stale, _ := newUser(t, pool, "Stale "+randSuffix(t))
	open, err := sessions.Create(ctx, busy.ID, "poker", "Sprint", []byte(`{"deck":"fibonacci"}`), owner.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	second, err := sessions.Create(ctx, busy.ID, "poker", "Other", []byte(`{"deck":"fibonacci"}`), owner.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	ended, err := sessions.Create(ctx, busy.ID, "poker", "Done", []byte(`{"deck":"fibonacci"}`), owner.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "update sessions set ended_at = now() where id = $1", ended.ID); err != nil {
		t.Fatal(err)
	}
	// owner in two open rounds counts once; guest once; stale is outside the
	// window; a live row on the ended round counts for nothing.
	for _, s := range []struct{ session, user string }{
		{open.ID, owner.ID}, {second.ID, owner.ID}, {open.ID, guest.ID}, {ended.ID, guest.ID},
	} {
		if err := p.Seen(ctx, s.session, s.user); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `insert into session_presence (session_id, user_id, replica_id, seen_at)
		values ($1, $2, 'r1', now() - interval '5 minutes')`, open.ID, stale.ID); err != nil {
		t.Fatal(err)
	}

	quiet, err := spaces.Create(ctx, defaultOrgID(t, pool), "Quiet", "quiet-"+randSuffix(t), "", owner.ID, VisibilityOrg, 50)
	if err != nil {
		t.Fatal(err)
	}

	got, err := spaces.ForUser(ctx, owner.ID, window)
	if err != nil {
		t.Fatal(err)
	}
	bySlug := map[string]Membership{}
	for _, m := range got {
		bySlug[m.Slug] = m
	}
	if m := bySlug[busy.Slug]; m.Open != 2 || m.Here != 2 {
		t.Fatalf("busy space: open=%d here=%d, want open=2 here=2", m.Open, m.Here)
	}
	if m := bySlug[quiet.Slug]; m.Open != 0 || m.Here != 0 {
		t.Fatalf("quiet space: open=%d here=%d, want 0/0", m.Open, m.Here)
	}
}
