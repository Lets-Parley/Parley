package store

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// at is a fixed instant on a fixed day, so every timestamp these tests write
// and every one they expect is a literal rather than something read back.
func at(hhmm string) time.Time {
	ts, err := time.Parse(time.RFC3339, "2026-03-02T"+hhmm+":00Z")
	if err != nil {
		panic(err)
	}
	return ts
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func summaryByID(t *testing.T, list []SessionSummary, id string) SessionSummary {
	t.Helper()
	for _, s := range list {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("session %s missing from the summaries", id)
	return SessionSummary{}
}

// A poker room's progress is its stories: how many carry a saved estimate out
// of how many there are. Its last activity is the latest of the moments the
// schema records — here a presence heartbeat, which is later than the story
// and the facilitator's last pong.
func TestSummariesCountPokerStoriesAndReadTheLatestActivity(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, members := newSession(t, pool, "Dana Whitfield", "Ben Alvarez")

	mustExec(t, pool, "update sessions set created_at = $2, facilitator_seen_at = $3 where id = $1",
		sess.ID, at("10:00"), at("10:05"))
	mustExec(t, pool, `insert into stories (session_id, title, position, estimate, status, created_at) values
		($1, 'Login', 1, '5', 'estimated', $2),
		($1, 'Logout', 2, null, 'pending', $3),
		($1, 'Signup', 3, null, 'voting', $4)`,
		sess.ID, at("10:10"), at("10:15"), at("10:20"))
	mustExec(t, pool, `insert into session_presence (session_id, user_id, replica_id, seen_at) values
		($1, $2, 'a', $3), ($1, $4, 'b', $5)`,
		sess.ID, members[0].ID, at("10:25"), members[1].ID, at("10:30"))

	list, err := (&Sessions{Pool: pool}).SummariesBySpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	got := summaryByID(t, list, sess.ID)
	if got.Stories != 3 || got.StoriesEstimated != 1 {
		t.Fatalf("stories = %d estimated %d, want 3 and 1", got.Stories, got.StoriesEstimated)
	}
	if !got.LastActivityAt.Equal(at("10:30")) {
		t.Fatalf("last activity = %s, want %s", got.LastActivityAt, at("10:30"))
	}
	if got.Title != "Sprint 12" || got.Kind != "poker" || got.FacilitatorID != members[0].ID {
		t.Fatalf("summary lost the session's own fields: %+v", got.Session)
	}
}

// Nothing can be written to a closed room, so a closed room's last activity is
// its close — even if a presence row outlives it, as one does until the sweep.
func TestAnEndedSessionsLastActivityIsItsEnd(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, members := newSession(t, pool, "Dana Whitfield")

	mustExec(t, pool, "update sessions set created_at = $2, facilitator_seen_at = $3, ended_at = $4 where id = $1",
		sess.ID, at("09:00"), at("09:10"), at("11:00"))
	mustExec(t, pool, `insert into session_presence (session_id, user_id, replica_id, seen_at) values ($1, $2, 'a', $3)`,
		sess.ID, members[0].ID, at("11:30"))

	list, err := (&Sessions{Pool: pool}).SummariesBySpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if got := summaryByID(t, list, sess.ID).LastActivityAt; !got.Equal(at("11:00")) {
		t.Fatalf("last activity = %s, want the end at %s", got, at("11:00"))
	}
}

// A room with nothing in it has still been created, and that is its activity.
func TestAnUntouchedSessionsLastActivityIsItsCreation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, _ := newSession(t, pool, "Dana Whitfield")
	mustExec(t, pool, "update sessions set created_at = $2, facilitator_seen_at = $3 where id = $1",
		sess.ID, at("08:00"), at("07:00"))

	list, err := (&Sessions{Pool: pool}).SummariesBySpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	got := summaryByID(t, list, sess.ID)
	if !got.LastActivityAt.Equal(at("08:00")) {
		t.Fatalf("last activity = %s, want the creation at %s", got.LastActivityAt, at("08:00"))
	}
	if got.Stories != 0 || got.StoriesEstimated != 0 || got.Entries != 0 || got.EntriesAnswered != 0 {
		t.Fatalf("empty room counted something: %+v", got)
	}
}

// A standup's progress is its queue: the people not skipped, and how many of
// them have written a non-blank update — the same "answered" the trend counts.
// An entry's edit is activity, and so is moving to the next speaker.
func TestSummariesCountStandupAnswersAndReadTheLatestActivity(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sp := newSpace(t, pool)
	spaces := &Spaces{Pool: pool}
	var ids []string
	for _, n := range []string{"Ana", "Bo", "Cy", "Di"} {
		u, _ := newUser(t, pool, n)
		if err := spaces.Join(ctx, sp.ID, u.ID); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, u.ID)
	}
	sess, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "standup", "Daily", []byte(`{}`), ids[0], 500)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, "update sessions set created_at = $2, facilitator_seen_at = $3, speaker_started_at = $4 where id = $1",
		sess.ID, at("09:00"), at("09:01"), at("09:20"))
	// Ana answered, Bo is whitespace only, Cy has not written, Di wrote and
	// was then skipped — out of the queue, so neither counted nor answered.
	mustExec(t, pool, `insert into standup_entries (session_id, user_id, today, position, skipped, updated_at) values
		($1, $2, 'shipping', 1, false, $6),
		($1, $3, E'  \n\t', 2, false, $7),
		($1, $4, '', 3, false, $8),
		($1, $5, 'away', 4, true, $9)`,
		sess.ID, ids[0], ids[1], ids[2], ids[3], at("09:05"), at("09:10"), at("09:15"), at("09:12"))

	list, err := (&Sessions{Pool: pool}).SummariesBySpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	got := summaryByID(t, list, sess.ID)
	if got.Entries != 3 || got.EntriesAnswered != 1 {
		t.Fatalf("entries = %d answered %d, want 3 and 1", got.Entries, got.EntriesAnswered)
	}
	if !got.LastActivityAt.Equal(at("09:20")) {
		t.Fatalf("last activity = %s, want the speaker change at %s", got.LastActivityAt, at("09:20"))
	}
}

// The summaries are the same list ListBySpace returns — this space's rooms,
// newest first — and never another space's.
func TestSummariesAreThisSpacesSessionsNewestFirst(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sessions := &Sessions{Pool: pool}
	first, members := newSession(t, pool, "Dana Whitfield")
	second, err := sessions.Create(ctx, first.SpaceID, "poker", "Later", []byte(`{}`), members[0].ID, 500)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, "update sessions set created_at = $2 where id = $1", first.ID, at("08:00"))
	mustExec(t, pool, "update sessions set created_at = $2 where id = $1", second.ID, at("09:00"))
	elsewhere, _ := newSession(t, pool, "Ben Alvarez")

	list, err := sessions.SummariesBySpace(ctx, first.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != second.ID || list[1].ID != first.ID {
		t.Fatalf("summaries = %v, want [%s %s]", list, second.ID, first.ID)
	}
	for _, s := range list {
		if s.ID == elsewhere.ID {
			t.Fatal("another space's session leaked into the summaries")
		}
	}
}
