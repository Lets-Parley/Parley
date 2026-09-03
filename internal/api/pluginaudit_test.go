package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
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

func installPlugin(t *testing.T, pool *pgxpool.Pool, name string, enabled bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`insert into plugin_installs (name, version, enabled, kv_quota_bytes) values ($1, '1.0.0', $2, 1024)`,
		name, enabled); err != nil {
		t.Fatal(err)
	}
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
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		t.Fatalf("expected the action to be refused, got %d", resp.StatusCode)
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
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		t.Fatalf("the plugin header let a non-member act: got %d", resp.StatusCode)
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
