package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// addStoryBody posts a raw story body so a test can send a ref without a title,
// which the typed helper in poker_test.go cannot express.
func addStoryBody(t *testing.T, srv *httptest.Server, sessionID, body string, c *http.Cookie) *http.Response {
	t.Helper()
	resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+sessionID+"/actions/stories", body, c)
	return resp
}

// lastStory returns the story most recently appended to the queue.
func lastStory(t *testing.T, srv *httptest.Server, sessionID string, c *http.Cookie) map[string]any {
	t.Helper()
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", c)
	stories := env["state"].(map[string]any)["stories"].([]any)
	if len(stories) == 0 {
		t.Fatal("no stories in queue")
	}
	return stories[len(stories)-1].(map[string]any)
}

// A ticket is addressable by its reference or by its title. Either one on its
// own is a whole ticket; only a blank pair is nonsense. The database has to
// agree, or a ref-only ticket is rejected by a check constraint as a 500.
func TestStoryIdentityOnCreate(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Identity Space")

	t.Run("ref only", func(t *testing.T) {
		if resp := addStoryBody(t, srv, id, `{"ref":"PAR-142"}`, fac); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("ref-only add: %d", resp.StatusCode)
		}
		story := lastStory(t, srv, id, fac)
		if story["ref"] != "PAR-142" || story["title"] != "" {
			t.Fatalf("ref-only story stored as %v", story)
		}
	})

	t.Run("title only", func(t *testing.T) {
		if resp := addStoryBody(t, srv, id, `{"title":"Rate limiting"}`, fac); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("title-only add: %d", resp.StatusCode)
		}
		story := lastStory(t, srv, id, fac)
		if story["title"] != "Rate limiting" || story["ref"] != "" {
			t.Fatalf("title-only story stored as %v", story)
		}
	})

	t.Run("neither is rejected", func(t *testing.T) {
		if resp := addStoryBody(t, srv, id, `{"title":"   ","ref":"  "}`, fac); resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("blank add: %d, want 400", resp.StatusCode)
		}
	})
}

// An edit must not strip a ticket of the last thing that names it.
func TestStoryIdentityOnPatch(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Identity Patch Space")
	if resp := addStoryBody(t, srv, id, `{"title":"Rate limiting","ref":"PAR-142"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("add: %d", resp.StatusCode)
	}
	story := lastStory(t, srv, id, fac)["id"].(string)

	// Dropping the title while the ref remains is a normal edit.
	if resp := patchStory(t, srv, id, story, `"title":""`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("blank the title: %d, want 204", resp.StatusCode)
	}
	if got := currentStory(secondArg(doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)), story); got["title"] != "" || got["ref"] != "PAR-142" {
		t.Fatalf("after blanking the title: %v", got)
	}

	// Dropping the ref too would leave nothing, so it is refused and the
	// ticket keeps the reference it had.
	if resp := patchStory(t, srv, id, story, `"ref":""`, fac); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank the last identifier: %d, want 400", resp.StatusCode)
	}
	if got := currentStory(secondArg(doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)), story); got["ref"] != "PAR-142" {
		t.Fatalf("rejected edit was not rolled back: %v", got)
	}

	// Swapping one identifier for the other in a single edit is fine.
	if resp := patchStory(t, srv, id, story, `"title":"Rate limiting","ref":""`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("swap identifiers: %d, want 204", resp.StatusCode)
	}
}

// A ticket that carries neither ref nor title cannot be created any more, but
// an unrelated edit to one must not be blocked by the identity check either.
func TestUnrelatedPatchIsNotBlockedByIdentity(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Identity Scope Space")
	if resp := addStoryBody(t, srv, id, `{"ref":"PAR-9"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("add: %d", resp.StatusCode)
	}
	story := lastStory(t, srv, id, fac)["id"].(string)
	if resp := patchStory(t, srv, id, story, `"estimate":"5"`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("estimate-only patch on a ref-only story: %d, want 204", resp.StatusCode)
	}
}

// secondArg keeps the envelope out of a temporary variable at each call site.
func secondArg(_ *http.Response, env map[string]any) map[string]any { return env }
