package standup

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// linkGuest mints a signed link on the session and a users row redeemed from
// it, as a redemption does. attached also writes the session_participants row
// that attaching to the room writes.
func linkGuest(t *testing.T, pool *pgxpool.Pool, sessionID, creator, name string, attached bool) string {
	t.Helper()
	ctx := context.Background()
	var linkID, id string
	if err := pool.QueryRow(ctx, `
		insert into session_links (session_id, created_by, token_hash, expires_at)
		values ($1, $2, gen_random_bytes(32), now() + interval '1 day') returning id::text`,
		sessionID, creator).Scan(&linkID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		"insert into users (name, link_id) values ($1, $2) returning id::text", name, linkID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if attached {
		if _, err := pool.Exec(ctx,
			"insert into session_participants (session_id, user_id) values ($1, $2)", sessionID, id); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func expectedIDs(st State) map[string]WireExpected {
	out := map[string]WireExpected{}
	if st.Expected != nil {
		for _, p := range *st.Expected {
			out[p.UserID] = p
		}
	}
	return out
}

// For an async standup the people owed an answer are the space's
// non-spectator members, whether or not they have opened the room, plus a
// link guest once it has attached. A redeemed link nobody has attached with
// owes nothing.
func TestAsyncStandupExpectsEveryNonSpectatorMember(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor", "Priya Raman")
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		"update members set spectator = true where user_id = $1", ids[2]); err != nil {
		t.Fatal(err)
	}
	gabe := linkGuest(t, pool, sess.ID, ids[0], "Gabe Guest", true)
	idle := linkGuest(t, pool, sess.ID, ids[0], "Idle Link", false)

	st := buildStandupState(t, pool, sess)
	got := expectedIDs(st)
	// Hand-worked: Dana and Ruth (members, never opened the room), Gabe
	// (attached guest). Not Priya (spectator), not the idle link.
	if len(got) != 3 {
		t.Fatalf("expected = %+v, want exactly Dana, Ruth and Gabe", got)
	}
	if p, ok := got[ids[1]]; !ok || p.Name != "Ruth Okafor" || p.Guest {
		t.Errorf("Ruth, who never opened the room, = %+v, want a named member", p)
	}
	if _, ok := got[ids[0]]; !ok {
		t.Error("Dana is missing")
	}
	if p, ok := got[gabe]; !ok || !p.Guest || p.Name != "Gabe Guest" {
		t.Errorf("attached guest = %+v, want Gabe marked as a guest", p)
	}
	if _, ok := got[ids[2]]; ok {
		t.Error("a spectator is owed no answer")
	}
	if _, ok := got[idle]; ok {
		t.Error("an unattached link is owed no answer")
	}
}

// A manual async standup created yesterday and still open serves no expected
// list: the day it is for is not today, so the digest must fall back to the
// room's participants rather than filing an away member under "Not yet"
// (#640, mirroring TestOpenAsyncStandupListsWhoIsAway's own-day gate).
func TestExpectedIsServedOnlyOnTheStandupsOwnDay(t *testing.T) {
	pool := testPool(t)
	sess, _ := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor")
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		"update sessions set created_at = now() - interval '1 day' where id = $1", sess.ID); err != nil {
		t.Fatal(err)
	}
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if st := buildStandupState(t, pool, sess); st.Expected != nil {
		t.Fatalf("yesterday's open async standup expected = %+v, want none", *st.Expected)
	}

	if _, err := pool.Exec(ctx, "delete from sessions; delete from members; delete from users; delete from spaces"); err != nil {
		t.Fatal(err)
	}
	today, _ := seed(t, pool, `{"mode":"async"}`, "Priya Raman")
	if st := buildStandupState(t, pool, today); st.Expected == nil {
		t.Fatal("today's open async standup expected = nil, want a list")
	}
}

// An ended async standup keeps its entries only; a sync room seats whoever is
// in it, as it did before (#601).
func TestExpectedIsServedOnlyByAnOpenAsyncStandup(t *testing.T) {
	pool := testPool(t)
	sess, _ := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield")
	ended := sess
	now := time.Now()
	ended.EndedAt = &now
	if st := buildStandupState(t, pool, ended); st.Expected != nil {
		t.Fatalf("ended standup expected = %+v, want none", *st.Expected)
	}
	if _, err := pool.Exec(context.Background(), "delete from sessions; delete from members; delete from users; delete from spaces"); err != nil {
		t.Fatal(err)
	}
	sync, _ := seed(t, pool, `{}`, "Dana Whitfield")
	if st := buildStandupState(t, pool, sync); st.Expected != nil {
		t.Fatalf("sync standup expected = %+v, want none", *st.Expected)
	}
}

// A link guest never receives who else the space expects: that is the space's
// roster, and the link is a capability on one room.
func TestGuestIsSentNoExpectedList(t *testing.T) {
	pool := testPool(t)
	sess, _ := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield")
	st := buildStandupState(t, pool, sess)
	if st.Expected == nil {
		t.Fatal("member's copy has no expected list")
	}
	if g := st.ForGuest().(State); g.Expected != nil {
		t.Fatalf("guest's copy expected = %+v, want none", *g.Expected)
	}
}

// Each entry carries its author's display name, so a reader whose roster no
// longer seats the author still sees who wrote it. A link guest's entry
// carries none: its name is whatever the guest typed, and without the roster's
// guest mark it could pass for a member's.
func TestEntriesCarryTheirMemberAuthorsName(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield")
	gabe := linkGuest(t, pool, sess.ID, ids[0], "Dana Whitfield", true)
	for i, u := range []string{ids[0], gabe} {
		if _, err := pool.Exec(context.Background(), `
			insert into standup_entries (session_id, user_id, today, position) values ($1, $2, 'x', $3)`,
			sess.ID, u, i+1); err != nil {
			t.Fatal(err)
		}
	}
	names := map[string]string{}
	for _, e := range buildStandupState(t, pool, sess).Entries {
		names[e.UserID] = e.Name
	}
	if names[ids[0]] != "Dana Whitfield" {
		t.Errorf("member's entry name = %q, want Dana Whitfield", names[ids[0]])
	}
	if n, ok := names[gabe]; !ok || n != "" {
		t.Errorf("guest's entry name = %q (present %v), want empty", n, ok)
	}
}
