package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// auditRecords reads what the org's audit log holds for one action.
func auditRecords(t *testing.T, pool *pgxpool.Pool, action string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`select coalesce(detail, '') from org_audit_log where action = $1 order by id`, action)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	details := []string{}
	for rows.Next() {
		var detail string
		if err := rows.Scan(&detail); err != nil {
			t.Fatal(err)
		}
		details = append(details, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return details
}

// installPlugin records an install in the default org — the org every room
// these tests open belongs to.
func installPlugin(t *testing.T, pool *pgxpool.Pool, name string, enabled bool) {
	t.Helper()
	installPluginInOrg(t, pool, defaultOrgID(t, pool), name, enabled)
}

// installPluginInOrg records an install against a named org. An install
// belongs to an org since 0034, and which org is the whole of what separates
// one tenant's plugins from another's.
func installPluginInOrg(t *testing.T, pool *pgxpool.Pool, orgID, name string, enabled bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`insert into plugin_installs (org_id, name, version, enabled, kv_quota_bytes)
		 values ($1, $2, '1.0.0', $3, 1024)`,
		orgID, name, enabled); err != nil {
		t.Fatal(err)
	}
}

func defaultOrgID(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		"select id from orgs where slug = $1", store.DefaultOrgSlug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// The plugin never holds a credential: the action arrives on the user's own
// cookie, is authorised as that user, and the log records which surface
// proposed it.
func TestAPluginMediatedActionIsRecordedWithThePluginAsTheRoute(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	installPlugin(t, pool, "retro", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	req, err := http.NewRequest("POST", srv.URL+"/api/sessions/"+sess+"/actions/reveal", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(pluginRouteHeader, "retro")
	req.AddCookie(dana)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		t.Fatalf("reveal through a plugin panel: got %d", resp.StatusCode)
	}

	records := auditRecords(t, pool, "plugin.action")
	if len(records) != 1 {
		t.Fatalf("audit records for a plugin action: got %d, want 1 (%v)", len(records), records)
	}
	if !strings.HasPrefix(records[0], "retro ") {
		t.Fatalf("the record does not name the plugin as the route: %q", records[0])
	}
	if !strings.Contains(records[0], "/actions/reveal") {
		t.Fatalf("the record does not say what was done: %q", records[0])
	}
}

// The record has to say who did it. Attribution is the whole point of the log:
// a record that names the plugin but the wrong person is worse than no record,
// because it reads as evidence. The existing coverage only ever went red on a
// foreign-key violation, so "always attribute to the org's first member" would
// have passed it — this reads actor_id back and compares it to the account
// whose cookie made the call.
func TestAPluginActionIsAttributedToTheActingUser(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	installPlugin(t, pool, "retro", true)

	// The facilitator opens the room; a plain member takes the action. An
	// attribution bug does not invent a random id — it pins the record to some
	// other principal in scope, and the facilitator is the one in scope here,
	// so actor and facilitator have to be different people for the assertion
	// to mean anything.
	fay := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Alpha Squad", fay)
	slug, code := sp["slug"].(string), sp["passcode"].(string)
	mel, melID := signupWithID(t, srv, "Mel")
	if resp := joinSpace(t, srv, slug, mel, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	resp, created := createSession(t, srv, slug, "poker", "Sprint 12", fay)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: %d %v", resp.StatusCode, created)
	}
	sess := created["id"].(string)
	story := addStory(t, srv, sess, "Login page", fay)
	selectStory(t, srv, sess, story, fay)

	req, _ := http.NewRequest("POST", srv.URL+"/api/sessions/"+sess+"/actions/vote",
		strings.NewReader(`{"storyId":"`+story+`","value":"5"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(pluginRouteHeader, "retro")
	req.AddCookie(mel)
	voted, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	voted.Body.Close()
	if voted.StatusCode < 200 || voted.StatusCode >= 300 {
		t.Fatalf("vote through a plugin panel: got %d", voted.StatusCode)
	}

	var actor, orgSlug string
	if err := pool.QueryRow(context.Background(),
		`select coalesce(actor_id::text, ''), org_slug from org_audit_log where action = 'plugin.action'`).
		Scan(&actor, &orgSlug); err != nil {
		t.Fatal(err)
	}
	if actor != melID {
		t.Fatalf("the plugin action was attributed to %q, want the acting user %q", actor, melID)
	}
	if orgSlug != store.DefaultOrgSlug {
		t.Fatalf("the record landed in org %q, want the room's own org %q", orgSlug, store.DefaultOrgSlug)
	}
}

// An install belongs to an org. Without the org predicate a plugin installed
// by any tenant on the instance satisfies the check for an action in every
// other tenant's room — the same class of hole as the panel list, and it puts
// a foreign plugin's name into this org's log.
func TestAPluginInstalledInAnotherOrgDoesNotSatisfyTheAuditCheck(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	ctx := context.Background()

	otherSlug := "other-" + randomSlugSuffix(t)
	var otherOrg string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id",
		otherSlug).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), "delete from orgs where id = $1", otherOrg) })
	// Installed in org B and nowhere else. The room below is in org A.
	installPluginInOrg(t, pool, otherOrg, "theirs", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	req, _ := http.NewRequest("POST", srv.URL+"/api/sessions/"+sess+"/actions/reveal", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(pluginRouteHeader, "theirs")
	req.AddCookie(dana)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// The control: the action itself succeeds, so an empty log is about the
	// plugin name being refused rather than about the action failing.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		t.Fatalf("reveal naming another org's plugin: got %d, want the action itself to succeed", resp.StatusCode)
	}

	if records := auditRecords(t, pool, "plugin.action"); len(records) != 0 {
		t.Fatalf("another org's install satisfied this org's audit check: %v", records)
	}
}

// A request header is user input. An unchecked one would let any visitor write
// arbitrary text into the org's audit log.
func TestAnActionNamingAPluginThisInstanceDoesNotRunIsNotRecorded(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	for _, claimed := range []string{"never-installed", "<script>alert(1)</script>"} {
		req, _ := http.NewRequest("POST", srv.URL+"/api/sessions/"+sess+"/actions/reveal", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(pluginRouteHeader, claimed)
		req.AddCookie(dana)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		// The control: the action itself must succeed, or "nothing was
		// recorded" would be about the action failing rather than about the
		// plugin name being refused.
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			t.Fatalf("reveal claiming plugin %q: got %d, want the action itself to succeed", claimed, resp.StatusCode)
		}
	}

	if records := auditRecords(t, pool, "plugin.action"); len(records) != 0 {
		t.Fatalf("an uninstalled plugin name was written to the audit log: %v", records)
	}
}

// A refused action is not an action.
func TestARefusedPluginActionIsNotRecorded(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	installPlugin(t, pool, "retro", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)

	// No such action: the dispatcher answers 404 and nothing happened.
	req, _ := http.NewRequest("POST", srv.URL+"/api/sessions/"+sess+"/actions/no-such-action", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(pluginRouteHeader, "retro")
	req.AddCookie(dana)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// The exact status, not merely "not 2xx": an unrelated 500 would satisfy
	// "refused" while telling us nothing about the dispatcher, and would keep
	// this test green through a regression it exists to catch.
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("an unknown action: got %d, want 404", resp.StatusCode)
	}

	if records := auditRecords(t, pool, "plugin.action"); len(records) != 0 {
		t.Fatalf("a refused action was recorded: %v", records)
	}
}

// The header authorises nothing. It is a label on a request the user's own
// session already had the right to make, so it must not turn a refusal into
// a success for anyone.
func TestThePluginRouteHeaderGrantsNothing(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	installPlugin(t, pool, "retro", true)

	dana := signup(t, srv, "Dana")
	createSpace(t, srv, "Alpha Squad", dana)
	sess := newPokerSession(t, srv, dana)
	// A stranger: a member of nothing, so the session gate refuses them.
	mallory := signup(t, srv, "Mallory")

	req, _ := http.NewRequest("POST", srv.URL+"/api/sessions/"+sess+"/actions/reveal", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(pluginRouteHeader, "retro")
	req.AddCookie(mallory)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// 404 exactly. requireSessionMember does not disclose that the room
	// exists, and "not 2xx" would pass on a 500 that proves nothing about the
	// gate.
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("the session gate on a stranger: got %d, want 404", resp.StatusCode)
	}
	if records := auditRecords(t, pool, "plugin.action"); len(records) != 0 {
		t.Fatalf("a refused stranger produced an audit record: %v", records)
	}
}

// newPokerSession opens a room and hands back its id.
func newPokerSession(t *testing.T, srv *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	resp, body := createSession(t, srv, "alpha-squad", "poker", "Sprint 12", cookie)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: got %d (%v)", resp.StatusCode, body)
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatalf("create session returned no id: %v", body)
	}
	return id
}
