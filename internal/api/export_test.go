package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
