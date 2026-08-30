package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func listDecks(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) (*http.Response, []map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/orgs/default/spaces/"+slug+"/decks", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

func createDeck(t *testing.T, srv *httptest.Server, slug, body string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	return doJSON(t, srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/decks", body, cookie)
}

// deckSpace is an owner, a joined member and a space with a passcode neither
// has to guess.
func deckSpace(t *testing.T, srv *httptest.Server) (owner, member *http.Cookie, slug string) {
	t.Helper()
	owner = signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Deck Space", owner)
	slug = sp["slug"].(string)
	member = signup(t, srv, "Member")
	if resp := joinSpace(t, srv, slug, member, sp["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: got %d", resp.StatusCode)
	}
	return owner, member, slug
}

func TestOwnerCreatesDeckVisibleOnlyInItsOwnSpace(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)

	resp, deck := createDeck(t, srv, slug, `{"name":"Team Deck","cards":["1","2","3"]}`, owner)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d (%v)", resp.StatusCode, deck)
	}
	if deck["name"] != "Team Deck" {
		t.Fatalf("name: got %v", deck["name"])
	}

	_, decks := listDecks(t, srv, slug, owner)
	if len(decks) != 1 || decks[0]["name"] != "Team Deck" {
		t.Fatalf("list: got %v", decks)
	}

	_, other := createSpace(t, srv, "Other Space", owner)
	_, otherDecks := listDecks(t, srv, other["slug"].(string), owner)
	if len(otherDecks) != 0 {
		t.Fatalf("decks leaked into another space: %v", otherDecks)
	}
}

func TestMemberReadsDecksButCannotWriteThem(t *testing.T) {
	srv := testServer(t)
	owner, member, slug := deckSpace(t, srv)
	_, deck := createDeck(t, srv, slug, `{"name":"Team Deck","cards":["1","2","3"]}`, owner)
	id := deck["id"].(string)

	resp, decks := listDecks(t, srv, slug, member)
	if resp.StatusCode != http.StatusOK || len(decks) != 1 {
		t.Fatalf("member list: got %d %v", resp.StatusCode, decks)
	}

	if resp, _ := createDeck(t, srv, slug, `{"name":"Sneak","cards":["1","2"]}`, member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member create: got %d, want 403", resp.StatusCode)
	}
	path := "/api/orgs/default/spaces/" + slug + "/decks/" + id
	if resp, _ := doJSON(t, srv, http.MethodPatch, path, `{"name":"Sneak","cards":["1","2"]}`, member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member update: got %d, want 403", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete, path, "", member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member delete: got %d, want 403", resp.StatusCode)
	}
}

// A non-member gets 404 rather than 403: a 403 would confirm the space exists.
func TestNonMemberGets404ListingDecks(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)
	createDeck(t, srv, slug, `{"name":"Team Deck","cards":["1","2","3"]}`, owner)

	stranger := signup(t, srv, "Stranger")
	resp, _ := listDecks(t, srv, slug, stranger)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger list: got %d, want 404", resp.StatusCode)
	}
}

// An id from another space must not be reachable by an owner of this one: the
// lookups are scoped by space_id, not by id alone.
func TestDeckIDFromAnotherSpaceIsNotReachable(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	_, a := createSpace(t, srv, "Space A", ada)
	_, deck := createDeck(t, srv, a["slug"].(string), `{"name":"Private Deck","cards":["1","2"]}`, ada)
	id := deck["id"].(string)

	bob := signup(t, srv, "Bob")
	_, b := createSpace(t, srv, "Space B", bob)
	path := "/api/orgs/default/spaces/" + b["slug"].(string) + "/decks/" + id

	if resp, _ := doJSON(t, srv, http.MethodPatch, path, `{"name":"Hijacked","cards":["9","8"]}`, bob); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-space update: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete, path, "", bob); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-space delete: got %d, want 404", resp.StatusCode)
	}
	_, decks := listDecks(t, srv, a["slug"].(string), ada)
	if len(decks) != 1 || decks[0]["name"] != "Private Deck" {
		t.Fatalf("deck was reachable from another space: %v", decks)
	}
}

func TestDeckCapReturnsAClear4xx(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{AllowedOrigin: testOrigin, Limits: Limits{DecksPerSpace: 1}})
	owner, _, slug := deckSpace(t, srv)
	if resp, _ := createDeck(t, srv, slug, `{"name":"First","cards":["1","2"]}`, owner); resp.StatusCode != http.StatusCreated {
		t.Fatalf("first create: got %d", resp.StatusCode)
	}
	resp, body := createDeck(t, srv, slug, `{"name":"Second","cards":["1","2"]}`, owner)
	if resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Fatalf("over-cap create: got %d, want a 4xx", resp.StatusCode)
	}
	if body["error"] == nil {
		t.Fatalf("over-cap create carried no error message: %v", body)
	}
}

func TestDeckCapIsAtomicAtCreationBoundary(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{AllowedOrigin: testOrigin, Limits: Limits{DecksPerSpace: 1}})
	owner, _, slug := deckSpace(t, srv)
	statuses := concurrentStatuses(t, 8, func(i int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/decks",
			fmt.Sprintf(`{"name":"Deck %d","cards":["1","2"]}`, i), owner)
	})
	requireStatuses(t, statuses, http.StatusCreated, http.StatusConflict, 1)
}

func TestDuplicateDeckNameInOneSpaceIsAConflict(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)
	createDeck(t, srv, slug, `{"name":"Team Deck","cards":["1","2"]}`, owner)
	resp, _ := createDeck(t, srv, slug, `{"name":"Team Deck","cards":["3","4"]}`, owner)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate name: got %d, want 409", resp.StatusCode)
	}
}

// The card rules are the session-create path's, not a second copy.
func TestDeckCardValidationMatchesSessionCreate(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)
	cases := []struct {
		name  string
		cards string
	}{
		{"one card", `["1"]`},
		{"sixteen cards", `["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16"]`},
		{"duplicate card", `["1","1","2"]`},
		{"reserved special", `["1","2","?"]`},
		{"over-long card", `["1","123456789"]`},
		{"non-numeric on a numeric deck", `["1","XL"]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, body := createDeck(t, srv, slug, `{"name":"Bad `+tc.name+`","cards":`+tc.cards+`}`, owner)
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("deck create: got %d, want 400", resp.StatusCode)
			}
			if body["error"] == nil {
				t.Fatalf("no error message: %v", body)
			}
			config := fmt.Sprintf(`{"deck":{"name":"Bad","values":%s,"ordinal":false}}`, tc.cards)
			resp, _ = createSessionWithConfig(t, srv, slug, "poker", "Session", config, owner)
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("session create with the same cards: got %d, want 400", resp.StatusCode)
			}
		})
	}
}

// A deck row named after a built-in cannot shadow it: the name is reserved
// unless the cards are exactly the built-in's, and resolution reads the
// built-in table rather than this space's rows either way.
func TestCustomDeckNamedFibonacciDoesNotShadowTheBuiltIn(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)
	if resp, _ := createDeck(t, srv, slug, `{"name":"fibonacci","cards":["100","200"]}`, owner); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("shadowing create: got %d, want 400", resp.StatusCode)
	}
	_, sess := createSessionWithConfig(t, srv, slug, "poker", "Legacy", `{"deck":"fibonacci"}`, owner)
	_, state := doJSON(t, srv, http.MethodGet, "/api/sessions/"+sess["id"].(string), "", owner)
	if !strings.Contains(fmt.Sprint(state), `34`) {
		t.Fatalf("fibonacci session did not resolve the built-in deck: %v", state)
	}
}

// Deleting a deck is safe because a session copied the cards it was created
// with: the room keeps working afterwards.
func TestDeletingADeckLeavesSessionsCreatedFromItPlayable(t *testing.T) {
	srv := testServer(t)
	owner, _, slug := deckSpace(t, srv)
	_, deck := createDeck(t, srv, slug, `{"name":"Team Deck","cards":["3","5","8"]}`, owner)

	config := `{"deck":{"name":"Team Deck","values":["3","5","8"],"ordinal":false}}`
	_, sess := createSessionWithConfig(t, srv, slug, "poker", "Sprint", config, owner)
	id := sess["id"].(string)
	story := addStory(t, srv, id, "Story", owner)
	selectStory(t, srv, id, story, owner)

	resp, _ := doJSON(t, srv, http.MethodDelete, "/api/orgs/default/spaces/"+slug+"/decks/"+deck["id"].(string), "", owner)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete deck: got %d", resp.StatusCode)
	}

	if resp := vote(t, srv, id, story, "5", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote after deck deletion: got %d", resp.StatusCode)
	}
	if resp, body := doJSON(t, srv, http.MethodPost, "/api/sessions/"+id+"/actions/reveal", "", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reveal after deck deletion: got %d (%v)", resp.StatusCode, body)
	}
	if resp := patchStory(t, srv, id, story, `"estimate":"5"`, owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("save estimate after deck deletion: got %d", resp.StatusCode)
	}
}
