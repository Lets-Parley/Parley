package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// titlesOf reads the room list back through the API, so every assertion below
// is made against what a client actually receives rather than against the
// database.
func titlesOf(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) []string {
	t.Helper()
	_, body := getSpace(t, srv, slug, cookie)
	raw, _ := body["sessions"].([]any)
	out := []string{}
	for _, s := range raw {
		if m, ok := s.(map[string]any); ok {
			if title, ok := m["title"].(string); ok {
				out = append(out, title)
			}
		}
	}
	return out
}

// A rename moves the display name and deliberately leaves the slug behind:
// every invite link already pasted into a chat keeps working.
func TestRenameSpaceKeepsTheSlug(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := createSpace(t, srv, "Platform Team", owner)
	slug, _ := created["slug"].(string)

	resp, body := doJSON(t, srv, "PATCH", "/api/spaces/"+slug, `{"name":"Platform Guild"}`, owner)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename: got %d, want 200 (%v)", resp.StatusCode, body)
	}
	if body["slug"] != slug {
		t.Fatalf("the slug moved: got %v, want %q", body["slug"], slug)
	}

	_, view := getSpace(t, srv, slug, owner)
	if view["name"] != "Platform Guild" {
		t.Fatalf("name after rename: got %v, want %q", view["name"], "Platform Guild")
	}
}

func TestRenameSpaceRejectsAnEmptyName(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := createSpace(t, srv, "Platform Team", owner)
	slug, _ := created["slug"].(string)

	resp, _ := doJSON(t, srv, "PATCH", "/api/spaces/"+slug, `{"name":"   "}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank rename: got %d, want 400", resp.StatusCode)
	}
}

// A plain member is refused with 403 — they can see the space, so its
// existence is not a secret from them. An outsider gets 404 instead.
func TestSpaceAdminIsOwnerOnly(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := createSpace(t, srv, "Platform Team", owner)
	slug, _ := created["slug"].(string)
	passcode, _ := created["passcode"].(string)

	member := signup(t, srv, "Member")
	joinSpace(t, srv, slug, member, passcode)
	outsider := signup(t, srv, "Outsider")

	for _, tc := range []struct {
		name   string
		method string
		body   string
	}{
		{"rename", "PATCH", `{"name":"Nope"}`},
		{"delete", "DELETE", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, _ := doJSON(t, srv, tc.method, "/api/spaces/"+slug, tc.body, member)
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("member: got %d, want 403", resp.StatusCode)
			}
			resp, _ = doJSON(t, srv, tc.method, "/api/spaces/"+slug, tc.body, outsider)
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("outsider: got %d, want 404", resp.StatusCode)
			}
		})
	}

	// Neither refusal did anything.
	_, view := getSpace(t, srv, slug, owner)
	if view["name"] != "Platform Team" {
		t.Fatalf("the space changed under a refused request: %v", view["name"])
	}
}

// Deleting a space takes its rooms with it. The cascade is the whole teardown,
// so this also proves the foreign keys are wired the way the store assumes.
func TestDeleteSpaceRemovesItsRooms(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := createSpace(t, srv, "Platform Team", owner)
	slug, _ := created["slug"].(string)
	sessResp, sess := createSession(t, srv, slug, "poker", "Sprint 12", owner)
	if sessResp.StatusCode != http.StatusCreated {
		t.Fatalf("creating the room: got %d", sessResp.StatusCode)
	}
	id, _ := sess["id"].(string)

	resp, _ := doJSON(t, srv, "DELETE", "/api/spaces/"+slug, "", owner)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: got %d, want 204", resp.StatusCode)
	}

	if got, _ := getSpace(t, srv, slug, owner); got.StatusCode != http.StatusNotFound {
		t.Fatalf("the space survived its own deletion: got %d, want 404", got.StatusCode)
	}
	if got, _ := doJSON(t, srv, "GET", "/api/sessions/"+id, "", owner); got.StatusCode != http.StatusNotFound {
		t.Fatalf("the room outlived its space: got %d, want 404", got.StatusCode)
	}
}

func TestRenameRoom(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := createSpace(t, srv, "Platform Team", owner)
	slug, _ := created["slug"].(string)
	_, sess := createSession(t, srv, slug, "poker", "Sprint 12", owner)
	id, _ := sess["id"].(string)

	resp, _ := doJSON(t, srv, "PATCH", "/api/spaces/"+slug+"/sessions/"+id, `{"title":"Sprint 13"}`, owner)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename: got %d, want 200", resp.StatusCode)
	}
	if got := titlesOf(t, srv, slug, owner); len(got) != 1 || got[0] != "Sprint 13" {
		t.Fatalf("titles after rename: %v", got)
	}
}

func TestDeleteRoomLeavesTheSpace(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := createSpace(t, srv, "Platform Team", owner)
	slug, _ := created["slug"].(string)
	_, keep := createSession(t, srv, slug, "poker", "Keep me", owner)
	_, drop := createSession(t, srv, slug, "poker", "Drop me", owner)
	dropID, _ := drop["id"].(string)

	resp, _ := doJSON(t, srv, "DELETE", "/api/spaces/"+slug+"/sessions/"+dropID, "", owner)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: got %d, want 204", resp.StatusCode)
	}
	if got := titlesOf(t, srv, slug, owner); len(got) != 1 || got[0] != "Keep me" {
		t.Fatalf("rooms after delete: %v", got)
	}
	if keep["id"] == dropID {
		t.Fatal("the fixture built two rooms with one id")
	}

	// Unlike closing, deleting is not idempotent: a second call names nothing.
	resp, _ = doJSON(t, srv, "DELETE", "/api/spaces/"+slug+"/sessions/"+dropID, "", owner)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("second delete: got %d, want 404", resp.StatusCode)
	}
}

// The authorization is over the space, so the query has to be too: owning one
// space must not reach a room in another, even with its id in hand.
func TestRoomAdminCannotReachAnotherSpace(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, mine := createSpace(t, srv, "Mine", owner)
	mySlug, _ := mine["slug"].(string)

	stranger := signup(t, srv, "Stranger")
	_, theirs := createSpace(t, srv, "Theirs", stranger)
	theirSlug, _ := theirs["slug"].(string)
	_, sess := createSession(t, srv, theirSlug, "poker", "Their sprint", stranger)
	victim, _ := sess["id"].(string)

	// Addressed through the space this caller does own, carrying an id from
	// the one they do not.
	resp, _ := doJSON(t, srv, "PATCH", "/api/spaces/"+mySlug+"/sessions/"+victim, `{"title":"Hijacked"}`, owner)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-space rename: got %d, want 404", resp.StatusCode)
	}
	resp, _ = doJSON(t, srv, "DELETE", "/api/spaces/"+mySlug+"/sessions/"+victim, "", owner)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-space delete: got %d, want 404", resp.StatusCode)
	}
	if got := titlesOf(t, srv, theirSlug, stranger); len(got) != 1 || got[0] != "Their sprint" {
		t.Fatalf("the other space's room was touched: %v", got)
	}
}

func TestRenameRoomRejectsAnEmptyTitle(t *testing.T) {
	srv := testServer(t)
	owner := signup(t, srv, "Owner")
	_, created := createSpace(t, srv, "Platform Team", owner)
	slug, _ := created["slug"].(string)
	_, sess := createSession(t, srv, slug, "poker", "Sprint 12", owner)
	id, _ := sess["id"].(string)

	resp, _ := doJSON(t, srv, "PATCH", "/api/spaces/"+slug+"/sessions/"+id, `{"title":"   "}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank title: got %d, want 400", resp.StatusCode)
	}
	resp, _ = doJSON(t, srv, "PATCH", "/api/spaces/"+slug+"/sessions/"+id,
		`{"title":"`+strings.Repeat("x", 201)+`"}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("over-long title: got %d, want 400", resp.StatusCode)
	}
	if got := titlesOf(t, srv, slug, owner); len(got) != 1 || got[0] != "Sprint 12" {
		t.Fatalf("the title changed under a refused rename: %v", got)
	}
}

// The whole point of the ErrNoSession teardown branch is that a deleted room
// does not leave people sitting in it. Asserting the 404 proves the cascade,
// not the disconnect: with the broadcast loop deleted entirely, every
// cascade assertion still passes. So this dials a real socket and requires it
// to close.
func TestDeletingClosesTheRoomSockets(t *testing.T) {
	for _, tc := range []struct {
		name string
		path func(slug, id string) string
	}{
		{"the room itself", func(slug, id string) string { return "/api/spaces/" + slug + "/sessions/" + id }},
		{"the whole space", func(slug, _ string) string { return "/api/spaces/" + slug }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := testServer(t)
			owner := signup(t, srv, "Owner")
			_, created := createSpace(t, srv, "Platform Team", owner)
			slug, _ := created["slug"].(string)
			_, sess := createSession(t, srv, slug, "poker", "Sprint 12", owner)
			id, _ := sess["id"].(string)

			ws, _, err := dialWS(t, srv, id, owner, testOrigin)
			if err != nil {
				t.Fatalf("dialing the room: %v", err)
			}
			defer ws.Close()
			// Drain the initial envelope, so the read below can only be the
			// close — otherwise a socket that never opened would pass.
			if _, ok := readEnvelope(t, ws, 2*time.Second); !ok {
				t.Fatal("no initial envelope — the socket never joined the room")
			}

			resp, body := doJSON(t, srv, "DELETE", tc.path(slug, id), "", owner)
			if resp.StatusCode != http.StatusNoContent {
				t.Fatalf("delete: got %d, want 204 (%v)", resp.StatusCode, body)
			}

			// The error has to be a close frame. A read deadline expiring is
			// also a non-nil error, and treating that as success would let
			// this pass against a socket nobody ever closed — which is
			// exactly what it did before this check was tightened.
			ws.SetReadDeadline(time.Now().Add(3 * time.Second))
			_, _, err = ws.ReadMessage()
			if err == nil {
				t.Fatal("the deleted room's websocket stayed open")
			}
			var closeErr *websocket.CloseError
			if !errors.As(err, &closeErr) {
				t.Fatalf("the socket was not closed by the server: %v", err)
			}
			if closeErr.Code != websocket.CloseGoingAway {
				t.Fatalf("close code = %d, want %d (going away)", closeErr.Code, websocket.CloseGoingAway)
			}
		})
	}
}
