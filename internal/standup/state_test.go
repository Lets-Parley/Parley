package standup

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/store"
)

func TestSecondsOrDefault(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   int
		want int
	}{
		{"unset falls back", 0, 90},
		{"negative falls back", -30, 90},
		{"a configured value wins", 45, 45},
		{"one second is a choice, not a mistake", 1, 1},
	} {
		if got := (Config{SecondsPerPerson: tc.in}).secondsOrDefault(); got != tc.want {
			t.Errorf("%s: secondsOrDefault(%d) = %d, want %d", tc.name, tc.in, got, tc.want)
		}
	}
}

// testPool hands back an empty, migrated database, mirroring internal/api.
// Every caller starts from a dropped schema so tests never inherit rows.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(context.Background(), "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background(), pool, slog.New(slog.NewTextHandler(os.Stderr, nil)), db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	return pool
}

// seed writes a space, a standup session and its members, returning the
// session and the user ids in the order they were named.
func seed(t *testing.T, pool *pgxpool.Pool, cfg string, names ...string) (store.Session, []string) {
	t.Helper()
	ctx := context.Background()
	var spaceID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (slug, name) values ('platform-team', 'Platform Team') returning id::text",
	).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(names))
	for _, n := range names {
		var id string
		if err := pool.QueryRow(ctx,
			"insert into users (name) values ($1) returning id::text", n,
		).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx,
			"insert into members (space_id, user_id) values ($1, $2)", spaceID, id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	var sessID string
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'standup', 'Daily', $2, $3) returning id::text`,
		spaceID, []byte(cfg), ids[0],
	).Scan(&sessID); err != nil {
		t.Fatal(err)
	}
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, sessID)
	if err != nil {
		t.Fatal(err)
	}
	return sess, ids
}

func buildStandupState(t *testing.T, pool *pgxpool.Pool, sess store.Session) State {
	t.Helper()
	got, err := buildState(context.Background(), pool, sess)
	if err != nil {
		t.Fatal(err)
	}
	st, ok := got.(State)
	if !ok {
		t.Fatalf("buildState returned %T, want State", got)
	}
	return st
}

// A standup nobody has written in must serialize as an empty list, not null:
// the frontend calls .find() on it the moment the page renders.
func TestBuildStateEmptyEntriesSerializeAsList(t *testing.T) {
	pool := testPool(t)
	sess, _ := seed(t, pool, `{}`, "Dana Whitfield")

	st := buildStandupState(t, pool, sess)
	if st.Entries == nil {
		t.Fatal("Entries is nil; it must be an empty slice")
	}
	blob, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Entries          *[]WireEntry `json:"entries"`
		CurrentSpeakerID *string      `json:"currentSpeakerId"`
		SpeakerStartedAt *time.Time   `json:"speakerStartedAt"`
		SecondsPerPerson int          `json:"secondsPerPerson"`
	}
	if err := json.Unmarshal(blob, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Entries == nil {
		t.Errorf("entries serialized as null, not []: %s", blob)
	}
	if wire.CurrentSpeakerID != nil || wire.SpeakerStartedAt != nil {
		t.Errorf("a standup that has not started must have no speaker: %s", blob)
	}
}

func TestBuildStateUsesTheDefaultSecondsWhenConfigIsSilent(t *testing.T) {
	pool := testPool(t)
	for _, cfg := range []string{`{}`, `{"secondsPerPerson":0}`, `{"secondsPerPerson":-5}`} {
		func() {
			if _, err := pool.Exec(context.Background(), "delete from sessions; delete from members; delete from users; delete from spaces"); err != nil {
				t.Fatal(err)
			}
			sess, _ := seed(t, pool, cfg, "Dana Whitfield")
			if got := buildStandupState(t, pool, sess).SecondsPerPerson; got != 90 {
				t.Errorf("config %s: secondsPerPerson = %d, want 90", cfg, got)
			}
		}()
	}
}

func TestBuildStateCarriesTheConfiguredSeconds(t *testing.T) {
	pool := testPool(t)
	sess, _ := seed(t, pool, `{"secondsPerPerson":45}`, "Dana Whitfield")
	if got := buildStandupState(t, pool, sess).SecondsPerPerson; got != 45 {
		t.Errorf("secondsPerPerson = %d, want 45", got)
	}
}

// A config that is not the shape this kind expects must not take the session
// down — the unmarshal error is deliberately swallowed and the default stands.
func TestBuildStateSurvivesAnUnreadableConfig(t *testing.T) {
	pool := testPool(t)
	sess, _ := seed(t, pool, `{"secondsPerPerson":"ninety"}`, "Dana Whitfield")
	st := buildStandupState(t, pool, sess)
	if st.SecondsPerPerson != 90 {
		t.Errorf("secondsPerPerson = %d, want the 90s default", st.SecondsPerPerson)
	}
}

func TestBuildStateReturnsEntriesInPositionOrder(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Marcus Okonjo", "Priya Raman")
	ctx := context.Background()
	// Inserted deliberately out of order: position decides, not insert order.
	for _, e := range []struct {
		user string
		pos  int
		body string
	}{
		{ids[2], 1, "priya"},
		{ids[0], 2, "dana"},
		{ids[1], 3, "marcus"},
	} {
		if _, err := pool.Exec(ctx, `
			insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
			values ($1, $2, '', $3, '', $4)`, sess.ID, e.user, e.body, e.pos); err != nil {
			t.Fatal(err)
		}
	}
	st := buildStandupState(t, pool, sess)
	want := []string{"priya", "dana", "marcus"}
	if len(st.Entries) != len(want) {
		t.Fatalf("got %d entries, want %d", len(st.Entries), len(want))
	}
	for i, w := range want {
		if st.Entries[i].Today != w {
			t.Errorf("entry %d = %q, want %q", i, st.Entries[i].Today, w)
		}
		if st.Entries[i].Position != float64(i+1) {
			t.Errorf("entry %d position = %v, want %d", i, st.Entries[i].Position, i+1)
		}
	}
}

func TestBuildStateReportsTheCurrentSpeaker(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Marcus Okonjo")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
		values ($1, $2, '', '', '', 1)`, sess.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"update sessions set current_speaker_id = $2, speaker_started_at = now() where id = $1",
		sess.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	st := buildStandupState(t, pool, sess)
	if st.CurrentSpeakerID == nil || *st.CurrentSpeakerID != ids[0] {
		t.Fatalf("currentSpeakerId = %v, want %s", st.CurrentSpeakerID, ids[0])
	}
	if st.SpeakerStartedAt == nil {
		t.Fatal("speakerStartedAt is nil while someone is speaking; the countdown has nothing to run from")
	}
}

func TestBuildStateCarriesTheSkippedFlag(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield")
	if _, err := pool.Exec(context.Background(), `
		insert into standup_entries (session_id, user_id, yesterday, today, blockers, position, skipped)
		values ($1, $2, '', '', '', 1, true)`, sess.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	st := buildStandupState(t, pool, sess)
	if len(st.Entries) != 1 || !st.Entries[0].Skipped {
		t.Fatalf("skipped flag lost: %+v", st.Entries)
	}
}

// Entries belong to one session; another standup in the same space must not
// bleed into this one's roster.
func TestBuildStateIgnoresAnotherSessionsEntries(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield")
	ctx := context.Background()
	var otherID string
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'standup', 'Yesterday''s Daily', '{}', $2) returning id::text`,
		sess.SpaceID, ids[0]).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
		values ($1, $2, '', 'belongs to the other standup', '', 1)`, otherID, ids[0]); err != nil {
		t.Fatal(err)
	}
	if st := buildStandupState(t, pool, sess); len(st.Entries) != 0 {
		t.Fatalf("leaked %d entries from another session: %+v", len(st.Entries), st.Entries)
	}
}
