package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"sort"
	"testing"
)

type rawRoom struct {
	Participants []struct {
		UserID string `json:"userId"`
	} `json:"participants"`
	State map[string]json.RawMessage `json:"state"`
}

func readRawRoom(t *testing.T, body []byte) rawRoom {
	t.Helper()
	var r rawRoom
	if err := json.Unmarshal(body, &r); err != nil {
		t.Fatalf("decoding room: %v (%s)", err, body)
	}
	return r
}

func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// #640, both decisions, against the real router. A member's copy of an open
// async standup expects a member who never opened it and not an unused link;
// a link guest's copy names the author of an entry it can read, though that
// author has left, and gains nothing else.
func TestAsyncStandupWaitsOnMembersAndNamesDepartedAuthorsForGuests(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	owner, _, spaceID, ids := trendSpace(t, srv, pool, 3)
	ctx := context.Background()
	var s string
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'standup', 'Daily', '{"mode":"async"}', $2) returning id::text`, spaceID, ids[0]).Scan(&s); err != nil {
		t.Fatal(err)
	}
	// Member 1 answered and is gone; Member 2 has never opened the room.
	if _, err := pool.Exec(ctx,
		"insert into standup_entries (session_id, user_id, today, position) values ($1, $2, 'shipped it', 1)", s, ids[1]); err != nil {
		t.Fatal(err)
	}
	_, minted := mintLink(t, srv, s, owner)
	token, _ := minted["token"].(string)
	// A second link, minted and never used.
	mintLink(t, srv, s, owner)

	_, body := getRaw(t, srv, "/api/sessions/"+s, owner)
	var mine struct {
		State struct {
			Expected []struct {
				UserID string `json:"userId"`
			} `json:"expected"`
		} `json:"state"`
	}
	if err := json.Unmarshal(body, &mine); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range mine.State.Expected {
		got = append(got, p.UserID)
	}
	want := append([]string(nil), ids...)
	sort.Strings(got)
	sort.Strings(want)
	if !slices.Equal(got, want) {
		t.Fatalf("member's copy: expected %v, want the three members %v and no link", got, want)
	}

	guest := redeemAs(t, srv, token, "Gus")
	status, body := getRaw(t, srv, "/api/sessions/"+s, guest)
	if status != http.StatusOK {
		t.Fatalf("guest read: %d %s", status, body)
	}
	room := readRawRoom(t, body)
	for _, p := range room.Participants {
		if p.UserID == ids[1] {
			t.Fatalf("the departed author was seated in the guest's roster: %s", body)
		}
	}
	stateKeys := []string{"away", "changes", "closesAt", "commitments", "currentSpeakerId", "entries", "kudos", "mode", "secondsPerPerson", "speakerStartedAt"}
	if k := sortedKeys(room.State); !slices.Equal(k, stateKeys) {
		t.Fatalf("guest state keys = %v, want exactly %v", k, stateKeys)
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(room.State["entries"], &entries); err != nil || len(entries) != 1 {
		t.Fatalf("guest entries: %v %s", err, room.State["entries"])
	}
	entryKeys := []string{"blockers", "name", "position", "postedAt", "ready", "skipped", "today", "userId", "yesterday"}
	if k := sortedKeys(entries[0]); !slices.Equal(k, entryKeys) {
		t.Fatalf("guest entry keys = %v, want exactly %v", k, entryKeys)
	}
	if string(entries[0]["name"]) != `"Member 1"` {
		t.Fatalf("guest entry name = %s, want \"Member 1\"", entries[0]["name"])
	}
}
