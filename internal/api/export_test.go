package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

// A kind retired in place must still export: the row that seeds the export
// mapping is untouched by retirement, only the create-session path is
// supposed to notice retired_at. Nothing in handleExportCSV references
// retired_at at all, so this is unpinned without a test exercising it.
func TestCSVExportOfARetiredKind(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	fac, member, id := setupSession(t, srv, "Retired Export Space")
	story := addStory(t, srv, id, "Retired story", fac)
	selectStory(t, srv, id, story, fac)
	vote(t, srv, id, story, "5", member)
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac)

	retireKind(t, pool, "poker")

	resp, body := fetchCSV(t, srv, id, member)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export of a session whose kind was retired after creation: got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "Mel: 5") {
		t.Fatalf("export of a retired kind's session missing vote detail:\n%s", body)
	}
}

func fetchCSV(t *testing.T, srv *httptest.Server, id string, c *http.Cookie) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/sessions/"+id+"/export.csv", nil)
	if c != nil {
		req.AddCookie(c)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(body)
}

// A plugin-provided kind must export from the same redacted wire state the
// room already carries — including formula-escaping a cell the plugin wrote.
func TestPluginKindCSVExport(t *testing.T) {
	srv, pool, plugins, host := hostServer(t)
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installCeremony(t, plugins, orgID, newPluginName(t), kind)
	st, err := plugins.State(context.Background(), in.ID)
	if err != nil {
		t.Fatal(err)
	}
	k := host.PluginKind(st, plugin.KindDef{Kind: kind, Display: "Retrospective"})
	k.State = func(_ context.Context, _ *pgxpool.Pool, _ store.Session) (any, error) {
		return map[string]any{"note": "=HYPERLINK evil"}, nil
	}
	if err := host.Kinds.Register(k); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Kinds.Unregister(kind) })

	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Plugin Export Space", fac)
	resp, body := createSession(t, srv, sp["slug"].(string), kind, "Plugin Retro", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a plugin-kind room: %d %v", resp.StatusCode, body)
	}
	id := body["id"].(string)

	resp, csv := fetchCSV(t, srv, id, fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("plugin kind export: got %d, want 200; body %q", resp.StatusCode, csv)
	}
	if !strings.Contains(csv, "'=HYPERLINK evil") {
		t.Fatalf("plugin export missing sanitized formula cell:\n%s", csv)
	}
}

func TestCSVExport(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Export Space")
	story := addStory(t, srv, id, "=HYPERLINK evil story", fac)
	selectStory(t, srv, id, story, fac)
	vote(t, srv, id, story, "5", member)

	// Non-members get nothing.
	outsider := signup(t, srv, "Out")
	if resp, _ := fetchCSV(t, srv, id, outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider export: %d", resp.StatusCode)
	}

	// Pre-reveal: no vote values, formula cell quoted, headers set.
	resp, body := fetchCSV(t, srv, id, member)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export: %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Disposition"), `filename="sprint-12.csv"`) {
		t.Fatalf("disposition: %q", resp.Header.Get("Content-Disposition"))
	}
	if !strings.Contains(body, `'=HYPERLINK evil story`) {
		t.Fatalf("formula cell not quoted:\n%s", body)
	}
	if strings.Contains(body, ": 5") {
		t.Fatalf("pre-reveal export leaked a vote value:\n%s", body)
	}

	// Post-reveal: values present.
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac)
	_, body = fetchCSV(t, srv, id, member)
	if !strings.Contains(body, "Mel: 5") {
		t.Fatalf("revealed export missing vote detail:\n%s", body)
	}
}

func TestStandupCSVExport(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, id, _ := standupSetup(t, srv, "Export Standup")
	doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"+plus formula","today":"tests","blockers":"none"}`, m1)

	_, body := fetchCSV(t, srv, id, fac)
	if !strings.Contains(body, "'+plus formula") {
		t.Fatalf("standup formula cell not quoted:\n%s", body)
	}
	if !strings.Contains(body, "Ben") || !strings.Contains(body, "tests") {
		t.Fatalf("standup export missing entry:\n%s", body)
	}
}

// Revoking a link must not cost the guest its name in the CSV: the export
// roster widens past the live links precisely so a finished meeting's
// attribution does not depend on whether the door is still open.
func TestCSVExportKeepsARevokedLinkGuestsName(t *testing.T) {
	srv := testServer(t)
	fac, id, guest := mintAndRedeem(t, srv, "Revoked Export Space")
	story := addStory(t, srv, id, "Guest story", fac)
	selectStory(t, srv, id, story, fac)
	vote(t, srv, id, story, "5", guest)
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac)

	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	linkID := list["links"].([]any)[0].(map[string]any)["id"].(string)
	doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac)

	resp, body := fetchCSV(t, srv, id, fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export after revoking a link: got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "Gus: 5") {
		t.Fatalf("revoked guest's name missing from the poker export:\n%s", body)
	}
}

// The standup renderer builds its own name map, so it needs its own test; it
// takes the expiry half of the criterion because revocation and expiry are one
// predicate in the roster's union and each arm is exercised once.
func TestStandupCSVExportKeepsAnExpiredLinkGuestsName(t *testing.T) {
	srv := testServer(t)
	fac, _, _, id, _ := standupSetup(t, srv, "Expired Export Standup")
	_, minted := mintLink(t, srv, id, fac)
	_, _, guest := redeem(t, srv, minted["token"].(string), "Gus")
	if guest == nil {
		t.Fatal("redeem set no session cookie")
	}
	doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"read","today":"tests","blockers":"none"}`, guest)

	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(),
		"update session_links set expires_at = now() - interval '1 minute' where session_id = $1", id); err != nil {
		t.Fatal(err)
	}

	resp, body := fetchCSV(t, srv, id, fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export after a link expired: got %d", resp.StatusCode)
	}
	if !strings.Contains(body, "Gus") {
		t.Fatalf("expired guest's name missing from the standup export:\n%s", body)
	}
}
