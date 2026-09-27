package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// The cap every test here creates against, small enough that exceeding it is
// three inserts rather than a hundred.
const testKudoCap = 3

func TestKudoRejectsItsOwnSender(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[0].ID, "thanks, me", "", testKudoCap); !errors.Is(err, ErrSelfKudo) {
		t.Fatalf("kudo to yourself: got %v, want ErrSelfKudo", err)
	}
}

// TestKudoRejectsItsOwnSender above goes through Create, which is CreateIn
// plus a transaction it owns. That already pins the guard for the common
// path, but the standup action calls CreateIn directly on a transaction it
// holds for its own reasons (internal/standup/kudos.go), and that path has
// no store-level test of its own. Assert the sentinel specifically, not just
// a 400: the membership check also fails a self-kudo (the IN-list dedups a
// repeated id down to one member), so a weaker assertion would not notice if
// the early guard were ever removed.
func TestKudoCreateInRefusesItsOwnSenderSpecifically(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	_, err = kudos.CreateIn(ctx, tx, sess.SpaceID, members[0].ID, members[0].ID, "thanks, me", "", testKudoCap)
	if !errors.Is(err, ErrSelfKudo) {
		t.Fatalf("err = %v, want ErrSelfKudo specifically (not ErrNotAMember)", err)
	}
}

func TestKudoRejectsANonMemberAndALinkGuest(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	// Somebody with a users row who never joined this space.
	outsider, _ := newUser(t, pool, "Outsider")
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, outsider.ID, "nice work", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo to a non-member: got %v, want ErrNotAMember", err)
	}

	// And a real link guest. A guest holds a users row but no members row, so
	// the foreign key will not catch this — the membership check is the only
	// defence, and this is the test that says so.
	clearIdentityBuckets(t, pool)
	links := &Links{Pool: pool}
	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	_, guestToken := NewToken()
	guest, err := (&Users{Pool: pool}).CreateForLink(ctx, "Gus", link.ID, guestToken, link.ExpiresAt, LinkRedemptionCap, "10.0.0.9", 10, 500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, guest.ID, "thanks Gus", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo to a link guest: got %v, want ErrNotAMember", err)
	}
}

func TestKudoDeleteIsTheSenderOnly(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	k, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "carried the release", "", testKudoCap)
	if err != nil {
		t.Fatal(err)
	}
	// The recipient is a member of the same space and still cannot delete it.
	if err := kudos.Delete(ctx, k.ID, members[1].ID); !errors.Is(err, ErrNoKudo) {
		t.Fatalf("delete by the recipient: got %v, want ErrNoKudo", err)
	}
	list, err := kudos.ListForSpace(ctx, sess.SpaceID, time.Time{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("after a refused delete the space has %d kudos, want 1", len(list))
	}
	if err := kudos.Delete(ctx, k.ID, members[0].ID); err != nil {
		t.Fatalf("delete by the sender: %v", err)
	}
	// A junk id is a lookup that found nothing, not a 500.
	if err := kudos.Delete(ctx, "not-a-uuid", members[0].ID); !errors.Is(err, ErrNoKudo) {
		t.Fatalf("delete of a malformed id: got %v, want ErrNoKudo", err)
	}
}

func TestKudoSurvivesTheSessionItWasGivenIn(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	k, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "unblocked me twice", sess.ID, testKudoCap)
	if err != nil {
		t.Fatal(err)
	}
	if k.SessionID != sess.ID {
		t.Fatalf("session id = %q, want %q", k.SessionID, sess.ID)
	}
	if err := (&Sessions{Pool: pool}).Delete(ctx, sess.ID, sess.SpaceID); err != nil {
		t.Fatal(err)
	}
	list, err := kudos.ListForSpace(ctx, sess.SpaceID, time.Time{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != k.ID {
		t.Fatalf("deleting the room took the kudo with it: %+v", list)
	}
	if list[0].SessionID != "" {
		t.Fatalf("session id after the room was deleted = %q, want empty", list[0].SessionID)
	}
}

func TestKudoListIsNewestFirstAndCapped(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	for _, text := range []string{"first", "second", "third"} {
		if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, text, "", testKudoCap); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "fourth", "", testKudoCap); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("past the per-space cap: got %v, want ErrQuotaExceeded", err)
	}

	list, err := kudos.ListForSpace(ctx, sess.SpaceID, time.Time{}, "")
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, k := range list {
		got = append(got, k.Text)
	}
	if strings.Join(got, ",") != "third,second,first" {
		t.Fatalf("list = %v, want newest first", got)
	}
}

func TestKudoTextIsBounded(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	for _, text := range []string{"", strings.Repeat("a", 281)} {
		if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, text, "", testKudoCap); err == nil {
			t.Fatalf("a %d-character kudo was accepted", len(text))
		}
	}
}

func TestKudoRejectsANonMemberAndALinkGuestAsSender(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	// The sending half of the same invariant: guests neither send nor receive.
	// The from_user_id foreign key points at users, not members, so it will not
	// catch either of these — the membership check is the only defence.
	outsider, _ := newUser(t, pool, "Outsider")
	if _, err := kudos.Create(ctx, sess.SpaceID, outsider.ID, members[0].ID, "nice work", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo from a non-member: got %v, want ErrNotAMember", err)
	}

	clearIdentityBuckets(t, pool)
	links := &Links{Pool: pool}
	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	_, guestToken := NewToken()
	guest, err := (&Users{Pool: pool}).CreateForLink(ctx, "Gus", link.ID, guestToken, link.ExpiresAt, LinkRedemptionCap, "10.0.0.9", 10, 500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, guest.ID, members[0].ID, "thanks Ada", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo from a link guest: got %v, want ErrNotAMember", err)
	}
}

// The cap counts a rolling 30 days, not a space's whole life: kudos older
// than the window free their slots, recent ones still hold them.
func TestKudoCapCountsOnlyTheLast30Days(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	for i := 0; i < testKudoCap; i++ {
		if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "thanks", "", testKudoCap); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "thanks", "", testKudoCap); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("recent kudos at the cap: got %v, want ErrQuotaExceeded", err)
	}
	if _, err := pool.Exec(ctx, "update kudos set created_at = now() - interval '31 days' where space_id = $1", sess.SpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "thanks", "", testKudoCap); err != nil {
		t.Fatalf("kudos older than the window blocked a new one: %v", err)
	}
}

// Paging walks the whole wall even when every row shares one microsecond-
// precise timestamp: the id breaks the tie, so nothing is skipped or repeated,
// and the cursor survives the RFC3339Nano round trip the browser makes.
func TestKudoPagesHaveNoGapsOrDuplicatesOnTiedTimestamps(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}
	for i := 0; i < 5; i++ {
		if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "thanks", "", 10); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, "update kudos set created_at = '2026-01-02 03:04:05.123456+00' where space_id = $1", sess.SpaceID); err != nil {
		t.Fatal(err)
	}
	old := kudoPage
	kudoPage = 2
	t.Cleanup(func() { kudoPage = old })

	seen := map[string]bool{}
	var before time.Time
	var beforeID string
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("paging did not terminate")
		}
		page, err := kudos.ListForSpace(ctx, sess.SpaceID, before, beforeID)
		if err != nil {
			t.Fatal(err)
		}
		for _, k := range page {
			if seen[k.ID] {
				t.Fatalf("kudo %s returned twice", k.ID)
			}
			seen[k.ID] = true
		}
		if len(page) < kudoPage {
			break
		}
		last := page[len(page)-1]
		wire, _ := last.CreatedAt.MarshalJSON()
		if err := before.UnmarshalJSON(wire); err != nil {
			t.Fatal(err)
		}
		beforeID = last.ID
	}
	if len(seen) != 5 {
		t.Fatalf("paged %d kudos, want 5", len(seen))
	}
}

func TestKudoCursorWithAMalformedIDIsABadCursor(t *testing.T) {
	pool := testPool(t)
	sess, _ := newSession(t, pool, "Ada", "Bo")
	_, err := (&Kudos{Pool: pool}).ListForSpace(context.Background(), sess.SpaceID, time.Now(), "not-a-uuid")
	if !errors.Is(err, ErrBadCursor) {
		t.Fatalf("got %v, want ErrBadCursor", err)
	}
}

// MarkSeen is the recipient's alone and scoped to the kudo's own space: the
// sender, a bystander and a right id in the wrong space all find nothing.
func TestKudoMarkSeenIsTheRecipientsInItsOwnSpace(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	other, _ := newSession(t, pool, "Cy")
	kudos := &Kudos{Pool: pool}

	k, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "carried the release", "", testKudoCap)
	if err != nil {
		t.Fatal(err)
	}
	if !k.Unread {
		t.Fatal("a new kudo should start unread")
	}
	if err := kudos.MarkSeen(ctx, sess.SpaceID, k.ID, members[0].ID); !errors.Is(err, ErrNoKudo) {
		t.Fatalf("seen by the sender: got %v, want ErrNoKudo", err)
	}
	if err := kudos.MarkSeen(ctx, other.SpaceID, k.ID, members[1].ID); !errors.Is(err, ErrNoKudo) {
		t.Fatalf("seen from another space: got %v, want ErrNoKudo", err)
	}
	if err := kudos.MarkSeen(ctx, sess.SpaceID, "not-a-uuid", members[1].ID); !errors.Is(err, ErrNoKudo) {
		t.Fatalf("seen with a malformed id: got %v, want ErrNoKudo", err)
	}
	list, _ := kudos.ListForSpace(ctx, sess.SpaceID, time.Time{}, "")
	if len(list) != 1 || !list[0].Unread {
		t.Fatalf("a refused MarkSeen changed the row: %+v", list)
	}
	for range 2 { // idempotent
		if err := kudos.MarkSeen(ctx, sess.SpaceID, k.ID, members[1].ID); err != nil {
			t.Fatalf("seen by the recipient: %v", err)
		}
	}
	list, _ = kudos.ListForSpace(ctx, sess.SpaceID, time.Time{}, "")
	if len(list) != 1 || list[0].Unread {
		t.Fatalf("after MarkSeen the kudo is still unread: %+v", list)
	}
}

// WaitingFor is one recipient's unread kudos in one space, newest first: never
// another member's, never a read one, never another space's.
func TestKudoWaitingForIsOnePersonsUnreadInOneSpace(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo", "Cy")
	other, others := newSession(t, pool, "Di", "Ed")
	kudos := &Kudos{Pool: pool}
	give := func(space, from, to, text string) Kudo {
		t.Helper()
		k, err := kudos.Create(ctx, space, from, to, text, "", 10)
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	ada, bo, cy := members[0].ID, members[1].ID, members[2].ID
	give(sess.SpaceID, ada, bo, "older")
	read := give(sess.SpaceID, cy, bo, "read already")
	give(sess.SpaceID, ada, cy, "to somebody else")
	give(sess.SpaceID, cy, bo, "newer")
	give(other.SpaceID, others[0].ID, others[1].ID, "another space")
	if err := kudos.MarkSeen(ctx, sess.SpaceID, read.ID, bo); err != nil {
		t.Fatal(err)
	}

	got, err := kudos.WaitingFor(ctx, sess.SpaceID, bo)
	if err != nil {
		t.Fatal(err)
	}
	texts := []string{}
	for _, k := range got {
		if !k.Unread || k.ToUserID != bo {
			t.Fatalf("WaitingFor returned %+v", k)
		}
		texts = append(texts, k.Text)
	}
	if strings.Join(texts, ",") != "newer,older" {
		t.Fatalf("WaitingFor = %v, want newer,older", texts)
	}
	// Bo is not in the other space, and its recipient's letters stay there.
	if got, _ := kudos.WaitingFor(ctx, other.SpaceID, bo); len(got) != 0 {
		t.Fatalf("another space's WaitingFor for Bo = %+v", got)
	}
	if got, _ := kudos.WaitingFor(ctx, sess.SpaceID, others[1].ID); len(got) != 0 {
		t.Fatalf("another space's recipient sees %+v here", got)
	}
	if _, err := kudos.WaitingFor(ctx, sess.SpaceID, "not-a-uuid"); err != nil {
		t.Fatalf("a malformed user id: %v, want an empty answer", err)
	}
}
