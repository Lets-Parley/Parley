package api

import (
	"net/http"
	"testing"
)

func TestStandupYesterdaySuggestion(t *testing.T) {
	srv := testServer(t)
	fac, author, other, previous, slug := standupSetup(t, srv, "Suggestion Space")
	newRoom := func(space, name string, owner *http.Cookie) string {
		t.Helper()
		r, body := createSession(t, srv, space, "standup", name, owner)
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create standup: %d %v", r.StatusCode, body)
		}
		return body["id"].(string)
	}
	post := func(id, text string, who *http.Cookie) {
		t.Helper()
		r, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup", `{"today":"`+text+`"}`, who)
		if r.StatusCode != http.StatusNoContent {
			t.Fatalf("save standup entry: %d", r.StatusCode)
		}
	}
	post(previous, "my earlier plan", author)
	post(previous, "a different author's plan", other)
	_, foreign := createSpace(t, srv, "Separate Suggestion Space", author)
	post(newRoom(foreign["slug"].(string), "Wrong space", author), "elsewhere", author)
	current := newRoom(slug, "Current", fac)
	post(newRoom(slug, "Next", fac), "from the future", author)

	path := "/api/sessions/" + current + "/standup-suggestion"
	expectSuggestion := func(who *http.Cookie, want string) {
		t.Helper()
		r, body := doJSON(t, srv, "GET", path, "", who)
		if r.StatusCode != http.StatusOK || len(body) != 1 || body["yesterday"] != want {
			t.Fatalf("suggestion = %d %v, want only yesterday=%q", r.StatusCode, body, want)
		}
		if got := r.Header.Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
	}
	expectSuggestion(author, "my earlier plan")
	expectSuggestion(other, "a different author's plan")
	if r, _ := doJSON(t, srv, "GET", path, "", nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("anonymous response: %d", r.StatusCode)
	}

	post(current, "already writing here", author)
	expectSuggestion(author, "")
}
