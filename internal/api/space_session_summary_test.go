package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

func fieldJSON(t *testing.T, row map[string]any, key string) string {
	t.Helper()
	v, ok := row[key]
	if !ok {
		t.Fatalf("row has no %q: %v", key, row)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// markPresent writes a live presence row directly, as a replica's heartbeat
// would, so the test controls exactly who is in the room without holding a
// socket open per person.
func markPresent(t *testing.T, sessionID string, userIDs ...string) {
	t.Helper()
	pool := testDBPool(t)
	for _, uid := range userIDs {
		if _, err := pool.Exec(context.Background(),
			`insert into session_presence (session_id, user_id, replica_id, seen_at) values ($1, $2, 'test', now())`,
			sessionID, uid); err != nil {
			t.Fatal(err)
		}
	}
}

// Who is in a live room is named from the space roster the caller can already
// read, facilitator first and then by name, five at most. A link guest in the
// room is counted in "here" but never named: the roster does not name them
// either, and a space member who wants to know who the guest is can walk in.
func TestSpaceSessionNamesWhoIsPresent(t *testing.T) {
	srv := testServer(t)
	fac, mel, id := setupSession(t, srv, "Present Space")
	slug := spaceSlugOf(t, srv, id, fac)

	ids := map[string]string{"Fay": userIDOf(t, srv, fac), "Mel": userIDOf(t, srv, mel)}
	_, view := getSpace(t, srv, slug, fac)
	code, _ := view["passcode"].(string)
	for _, n := range []string{"Eve", "Dee", "Cal", "Bob", "Ann"} {
		c := signup(t, srv, n)
		if resp := joinSpace(t, srv, slug, c, code); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("join %s: %d", n, resp.StatusCode)
		}
		ids[n] = userIDOf(t, srv, c)
	}
	_, minted := mintLink(t, srv, id, fac)
	// "Abe" sorts ahead of every member but the facilitator, so if the
	// roster projection slipped he would be named inside the first five.
	guest := redeemAs(t, srv, minted["token"].(string), "Abe")

	markPresent(t, id, ids["Mel"], ids["Eve"], ids["Dee"], ids["Cal"], ids["Bob"], ids["Ann"], ids["Fay"], userIDOf(t, srv, guest))
	_, empty := createSession(t, srv, slug, "poker", "Nobody home", fac)

	rows := spaceSessionRows(t, srv, slug, fac)
	row := rows[id]
	if got := int(row["here"].(float64)); got != 8 {
		t.Fatalf("here = %d, want all 8 including the guest", got)
	}
	want := `[{"facilitator":true,"id":"` + ids["Fay"] + `","name":"Fay"},` +
		`{"facilitator":false,"id":"` + ids["Ann"] + `","name":"Ann"},` +
		`{"facilitator":false,"id":"` + ids["Bob"] + `","name":"Bob"},` +
		`{"facilitator":false,"id":"` + ids["Cal"] + `","name":"Cal"},` +
		`{"facilitator":false,"id":"` + ids["Dee"] + `","name":"Dee"}]`
	if got := fieldJSON(t, row, "present"); got != want {
		t.Fatalf("present =\n %s\nwant\n %s", got, want)
	}
	if got := fieldJSON(t, rows[empty["id"].(string)], "present"); got != `[]` {
		t.Fatalf("empty room present = %s, want []", got)
	}

	// An ended room names nobody, whatever presence rows are left over.
	closeSession(t, srv, id, fac)
	if got := fieldJSON(t, spaceSessionRows(t, srv, slug, fac)[id], "present"); got != `[]` {
		t.Fatalf("ended room present = %s, want []", got)
	}
}

// Progress is per kind and says which kind it is, so a client can switch on
// it: a poker room counts stories with a saved estimate, a standup counts
// written updates across its queue.
func TestSpaceSessionReportsProgressPerKind(t *testing.T) {
	srv := testServer(t)
	fac, mel, pokerID := setupSession(t, srv, "Progress Space")
	slug := spaceSlugOf(t, srv, pokerID, fac)
	_, standup := createSession(t, srv, slug, "standup", "Daily", fac)
	standupID := standup["id"].(string)

	pool := testDBPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `insert into stories (session_id, title, position, estimate, status) values
		($1, 'Login', 1, '5', 'estimated'), ($1, 'Logout', 2, null, 'pending'), ($1, 'Signup', 3, null, 'voting')`,
		pokerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into standup_entries (session_id, user_id, today, position) values
		($1, $2, 'shipping', 1), ($1, $3, '', 2)`,
		standupID, userIDOf(t, srv, fac), userIDOf(t, srv, mel)); err != nil {
		t.Fatal(err)
	}

	rows := spaceSessionRows(t, srv, slug, fac)
	if got := fieldJSON(t, rows[pokerID], "progress"); got != `{"kind":"poker","settled":1,"total":3}` {
		t.Fatalf("poker progress = %s", got)
	}
	if got := fieldJSON(t, rows[standupID], "progress"); got != `{"answered":1,"kind":"standup","total":2}` {
		t.Fatalf("standup progress = %s", got)
	}
}

// A closed room's last activity is its close, written as a UTC instant.
func TestSpaceSessionReportsLastActivity(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Activity Space")
	slug := spaceSlugOf(t, srv, id, fac)
	closeSession(t, srv, id, fac)
	if _, err := testDBPool(t).Exec(context.Background(),
		"update sessions set ended_at = '2026-03-02T11:00:00Z' where id = $1", id); err != nil {
		t.Fatal(err)
	}
	if got := fieldJSON(t, spaceSessionRows(t, srv, slug, fac)[id], "lastActivityAt"); got != `"2026-03-02T11:00:00Z"` {
		t.Fatalf("lastActivityAt = %s, want the close", got)
	}
}

// A kind a plugin provides has no progress Parley knows how to count, so it
// says so with null rather than borrowing a core kind's shape.
func TestAPluginKindsSessionReportsNoProgress(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, plugins, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})
	registerStubKind(t, host, kind, in.OrgID, func(store.Session) any {
		return map[string]any{"columns": []string{"went-well"}}
	})

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Plugin Progress Space", fac)
	slug := sp["slug"].(string)
	resp, body := createSession(t, srv, slug, kind, "Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a room of a plugin-provided kind: %d %v", resp.StatusCode, body)
	}
	if got := fieldJSON(t, spaceSessionRows(t, srv, slug, fac)[body["id"].(string)], "progress"); got != `null` {
		t.Fatalf("plugin kind progress = %s, want null", got)
	}
}

// Two people present under the same display name are told apart by id, so
// the order is the same on every request rather than whatever order presence
// happened to report them in. The facilitator still comes first and names
// still sort before ids.
func TestPresentInBreaksANameTieByID(t *testing.T) {
	sess := store.Session{FacilitatorID: "ffffffff-0000-0000-0000-000000000009"}
	names := map[string]string{
		"ffffffff-0000-0000-0000-000000000009": "Sam",
		"bbbbbbbb-0000-0000-0000-000000000002": "Sam",
		"aaaaaaaa-0000-0000-0000-000000000001": "Sam",
		"cccccccc-0000-0000-0000-000000000003": "Ann",
	}
	here := []string{
		"bbbbbbbb-0000-0000-0000-000000000002",
		"ffffffff-0000-0000-0000-000000000009",
		"cccccccc-0000-0000-0000-000000000003",
		"aaaaaaaa-0000-0000-0000-000000000001",
	}
	got, err := json.Marshal(presentIn(sess, here, names))
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"id":"ffffffff-0000-0000-0000-000000000009","name":"Sam","facilitator":true},` +
		`{"id":"cccccccc-0000-0000-0000-000000000003","name":"Ann","facilitator":false},` +
		`{"id":"aaaaaaaa-0000-0000-0000-000000000001","name":"Sam","facilitator":false},` +
		`{"id":"bbbbbbbb-0000-0000-0000-000000000002","name":"Sam","facilitator":false}]`
	if string(got) != want {
		t.Fatalf("present =\n %s\nwant\n %s", got, want)
	}
}
