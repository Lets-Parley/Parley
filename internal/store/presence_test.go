package store

import (
	"context"
	"testing"
	"time"
)

// Seen refreshes presence only. Writing session_participants on every pong
// was a PK probe on the hottest path in the room; belonging is recorded once,
// on attach, via Join.
func TestSeenDoesNotWriteSessionParticipants(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sp, u := newSpaceWithCreator(t, pool)
	sess, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "poker", "Sprint", []byte(`{"deck":"fibonacci"}`), u.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	p := &Presence{Pool: pool, ReplicaID: "r1", Window: time.Minute}

	if err := p.Seen(ctx, sess.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_participants where session_id = $1", sess.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("Seen wrote %d session_participants row(s); belonging belongs on Join, not the heartbeat", n)
	}
}

func TestJoinRecordsSessionParticipantOnce(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sp, u := newSpaceWithCreator(t, pool)
	sess, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "poker", "Sprint", []byte(`{"deck":"fibonacci"}`), u.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	p := &Presence{Pool: pool, ReplicaID: "r1", Window: time.Minute}

	if err := p.Join(ctx, sess.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := p.Join(ctx, sess.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_participants where session_id = $1 and user_id = $2",
		sess.ID, u.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("Join left %d rows, want exactly 1", n)
	}
}

// A long-lived room must not keep every historical joiner forever: once the
// cap is hit, the oldest row gives way so snapshotVoters cannot copy an
// unbounded roster. The session's facilitator is never the one dropped.
func TestJoinPrunesOldestWhenOverCap(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sp, owner := newSpaceWithCreator(t, pool)
	sess, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "poker", "Sprint", []byte(`{"deck":"fibonacci"}`), owner.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	p := &Presence{Pool: pool, ReplicaID: "r1", Window: time.Minute}

	old := maxSessionParticipants
	maxSessionParticipants = 3
	t.Cleanup(func() { maxSessionParticipants = old })

	ids := make([]string, 0, 4)
	for i := 0; i < 4; i++ {
		u, _ := newUser(t, pool, "P")
		ids = append(ids, u.ID)
		if _, err := pool.Exec(ctx,
			`insert into session_participants (session_id, user_id, joined_at)
			 values ($1, $2, now() - ($3 * interval '1 second'))
			 on conflict do nothing`, sess.ID, u.ID, 10-i); err != nil {
			t.Fatal(err)
		}
	}
	fifth, _ := newUser(t, pool, "New")
	if err := p.Join(ctx, sess.ID, fifth.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_participants where session_id = $1", sess.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("after Join over the cap: %d participants, want 3", n)
	}
	var stillOldest bool
	if err := pool.QueryRow(ctx,
		"select exists (select 1 from session_participants where session_id = $1 and user_id = $2)",
		sess.ID, ids[0]).Scan(&stillOldest); err != nil {
		t.Fatal(err)
	}
	if stillOldest {
		t.Fatal("Join over the cap kept the oldest participant; it should have been pruned")
	}
	var hasFifth bool
	if err := pool.QueryRow(ctx,
		"select exists (select 1 from session_participants where session_id = $1 and user_id = $2)",
		sess.ID, fifth.ID).Scan(&hasFifth); err != nil {
		t.Fatal(err)
	}
	if !hasFifth {
		t.Fatal("Join over the cap dropped the newcomer instead of the oldest")
	}
}

// The facilitator is typically the oldest joined_at. Cap churn that dropped
// them would omit them from the next open-voting snapshot while their socket
// was still up, and the rest of the table could auto-reveal before they cast.
func TestJoinKeepsFacilitatorWhenOverCap(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sp, owner := newSpaceWithCreator(t, pool)
	sess, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "poker", "Sprint", []byte(`{"deck":"fibonacci"}`), owner.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	p := &Presence{Pool: pool, ReplicaID: "r1", Window: time.Minute}

	old := maxSessionParticipants
	maxSessionParticipants = 3
	t.Cleanup(func() { maxSessionParticipants = old })

	if _, err := pool.Exec(ctx,
		`insert into session_participants (session_id, user_id, joined_at)
		 values ($1, $2, now() - interval '1 hour')`, sess.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		u, _ := newUser(t, pool, "P")
		if _, err := pool.Exec(ctx,
			`insert into session_participants (session_id, user_id, joined_at)
			 values ($1, $2, now() - ($3 * interval '1 second'))`,
			sess.ID, u.ID, 3-i); err != nil {
			t.Fatal(err)
		}
	}
	newest, _ := newUser(t, pool, "New")
	if err := p.Join(ctx, sess.ID, newest.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_participants where session_id = $1", sess.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("after Join over the cap: %d participants, want 3", n)
	}
	var hasFac bool
	if err := pool.QueryRow(ctx,
		"select exists (select 1 from session_participants where session_id = $1 and user_id = $2)",
		sess.ID, owner.ID).Scan(&hasFac); err != nil {
		t.Fatal(err)
	}
	if !hasFac {
		t.Fatal("Join over the cap dropped the facilitator")
	}
}

// A facilitator removal clears presence in the same transaction that prunes
// the open round and re-checks completion, because that transaction can commit
// a reveal. If the presence clear did not share the transaction's fate, a
// failure after the prune would leave the round altered — possibly revealed —
// for somebody still fully connected, and no retry could undo it.
// GoneTx clears one row: this session, this user, this replica. Each predicate
// is load-bearing on its own — a missing session_id would eject somebody from
// every room at once, and a missing replica_id would delete a row another
// replica owns and is responsible for clearing.
func TestGoneTxClearsOnlyItsOwnSessionUserAndReplica(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sp, u := newSpaceWithCreator(t, pool)
	other, _ := newUser(t, pool, "Other")
	sessions := &Sessions{Pool: pool}
	a, err := sessions.Create(ctx, sp.ID, "poker", "Room A", []byte(`{"deck":"fibonacci"}`), u.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	b, err := sessions.Create(ctx, sp.ID, "poker", "Room B", []byte(`{"deck":"fibonacci"}`), u.ID, 50)
	if err != nil {
		t.Fatal(err)
	}

	r1 := &Presence{Pool: pool, ReplicaID: "r1", Window: time.Minute}
	r2 := &Presence{Pool: pool, ReplicaID: "r2", Window: time.Minute}
	// The row to clear, plus one differing in each predicate.
	for _, seed := range []struct {
		p       *Presence
		session string
		user    string
	}{
		{r1, a.ID, u.ID},     // the target
		{r1, b.ID, u.ID},     // same user and replica, another room
		{r1, a.ID, other.ID}, // same room and replica, another person
		{r2, a.ID, u.ID},     // same room and person, another replica
	} {
		if err := seed.p.Seen(ctx, seed.session, seed.user); err != nil {
			t.Fatal(err)
		}
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := r1.GoneTx(ctx, tx, a.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	rows := func(session, user, replica string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx,
			`select count(*) from session_presence
			 where session_id = $1 and user_id = $2 and replica_id = $3`,
			session, user, replica).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := rows(a.ID, u.ID, "r1"); n != 0 {
		t.Fatalf("the target row survived: %d", n)
	}
	if n := rows(b.ID, u.ID, "r1"); n != 1 {
		t.Fatalf("room B lost the same person: %d rows, want 1 — the session predicate is missing", n)
	}
	if n := rows(a.ID, other.ID, "r1"); n != 1 {
		t.Fatalf("another person lost their seat: %d rows, want 1 — the user predicate is missing", n)
	}
	if n := rows(a.ID, u.ID, "r2"); n != 1 {
		t.Fatalf("another replica's row was deleted: %d rows, want 1 — the replica predicate is missing", n)
	}
}

func TestGoneTxSharesTheCallersTransaction(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sp, u := newSpaceWithCreator(t, pool)
	sess, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "poker", "Sprint", []byte(`{"deck":"fibonacci"}`), u.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	p := &Presence{Pool: pool, ReplicaID: "r1", Window: time.Minute}
	present := func() int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx,
			"select count(*) from session_presence where session_id = $1 and user_id = $2",
			sess.ID, u.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	if err := p.Seen(ctx, sess.ID, u.ID); err != nil {
		t.Fatal(err)
	}

	// A transaction that fails after the clear leaves the person present.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.GoneTx(ctx, tx, sess.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if n := present(); n != 1 {
		t.Fatalf("a rolled-back transaction left %d presence rows, want 1 — the clear did not share its fate", n)
	}

	// One that commits clears them.
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.GoneTx(ctx, tx, sess.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if n := present(); n != 0 {
		t.Fatalf("a committed GoneTx left %d presence rows, want 0", n)
	}
}
