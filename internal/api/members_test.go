package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// signupWithID returns both the session cookie and the user id behind it, which
// membership routes need because they address a member by id in the path.
func signupWithID(t *testing.T, srv *httptest.Server, name string) (*http.Cookie, string) {
	t.Helper()
	resp, body := postMe(t, srv, name, nil)
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatalf("no user id in the /api/me response: %v", body)
	}
	return sessionCookieOf(t, resp), id
}

func setRole(t *testing.T, srv *httptest.Server, slug, userID, role string, cookie *http.Cookie) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/members/"+userID+"/role",
		strings.NewReader(`{"role":"`+role+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(body)
}

func removeMember(t *testing.T, srv *httptest.Server, slug, userID string, cookie *http.Cookie) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/spaces/"+slug+"/members/"+userID, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(body)
}

// rolesOf reads the roster back through the API and maps user id to role, so
// every assertion below is made against what a client actually receives.
func rolesOf(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) map[string]string {
	t.Helper()
	_, body := getSpace(t, srv, slug, cookie)
	raw, ok := body["members"]
	if !ok {
		t.Fatalf("no members in the space view: %v", body)
	}
	blob, _ := json.Marshal(raw)
	var members []struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	json.Unmarshal(blob, &members)
	roles := map[string]string{}
	for _, m := range members {
		roles[m.UserID] = m.Role
	}
	return roles
}

// spaceWithTwo stands up an owner-plus-member space and returns everything the
// membership tests need to address either of them.
func spaceWithTwo(t *testing.T, srv *httptest.Server) (slug string, owner *http.Cookie, ownerID string, member *http.Cookie, memberID string) {
	t.Helper()
	owner, ownerID = signupWithID(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Members "+randomName(t), owner)
	slug, _ = sp["slug"].(string)
	if slug == "" {
		t.Fatalf("no slug from create: %v", sp)
	}
	passcode, _ := sp["passcode"].(string)
	member, memberID = signupWithID(t, srv, "Bob")
	if resp := joinSpace(t, srv, slug, member, passcode); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: got %d", resp.StatusCode)
	}
	return slug, owner, ownerID, member, memberID
}

func randomName(t *testing.T) string {
	t.Helper()
	return strings.ReplaceAll(t.Name(), "/", " ")
}

func TestRosterExposesRolesAndTheCreatorOwnsTheSpace(t *testing.T) {
	srv := testServer(t)
	slug, owner, ownerID, _, memberID := spaceWithTwo(t, srv)

	roles := rolesOf(t, srv, slug, owner)
	if roles[ownerID] != "owner" {
		t.Fatalf("creator role = %q, want owner", roles[ownerID])
	}
	if roles[memberID] != "member" {
		t.Fatalf("joiner role = %q, want member", roles[memberID])
	}
}

func TestOwnerPromotesAndDemotes(t *testing.T) {
	srv := testServer(t)
	slug, owner, ownerID, member, memberID := spaceWithTwo(t, srv)

	if resp, body := setRole(t, srv, slug, memberID, "owner", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("promote: got %d %s", resp.StatusCode, body)
	}
	if got := rolesOf(t, srv, slug, owner)[memberID]; got != "owner" {
		t.Fatalf("after promote role = %q, want owner", got)
	}
	// The newly promoted owner can now demote the original one — the promotion
	// has to carry real authority, not just a label on the roster.
	if resp, body := setRole(t, srv, slug, ownerID, "member", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("demote by the new owner: got %d %s", resp.StatusCode, body)
	}
	if got := rolesOf(t, srv, slug, member)[ownerID]; got != "member" {
		t.Fatalf("after demote role = %q, want member", got)
	}
}

func TestPlainMembersCannotManageMembership(t *testing.T) {
	srv := testServer(t)
	slug, _, ownerID, member, memberID := spaceWithTwo(t, srv)

	if resp, body := setRole(t, srv, slug, memberID, "owner", member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("self-promotion by a plain member: got %d %s, want 403", resp.StatusCode, body)
	}
	if resp, body := removeMember(t, srv, slug, ownerID, member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a plain member removing the owner: got %d %s, want 403", resp.StatusCode, body)
	}
	// And nothing changed on the way to the refusal.
	roles := rolesOf(t, srv, slug, member)
	if roles[memberID] != "member" || roles[ownerID] != "owner" {
		t.Fatalf("roles moved despite the refusal: %v", roles)
	}
}

func TestStrangersAreNotToldTheSpaceExists(t *testing.T) {
	srv := testServer(t)
	slug, _, ownerID, _, _ := spaceWithTwo(t, srv)
	stranger, _ := signupWithID(t, srv, "Mallory")

	if resp, body := setRole(t, srv, slug, ownerID, "member", stranger); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger setting a role: got %d %s, want 404", resp.StatusCode, body)
	}
	if resp, body := removeMember(t, srv, slug, ownerID, stranger); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger removing a member: got %d %s, want 404", resp.StatusCode, body)
	}
	if resp, body := removeMember(t, srv, slug, ownerID, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous removing a member: got %d %s, want 401", resp.StatusCode, body)
	}
}

func TestTheLastOwnerCannotBeDemotedOrRemoved(t *testing.T) {
	srv := testServer(t)
	slug, owner, ownerID, _, _ := spaceWithTwo(t, srv)

	resp, body := setRole(t, srv, slug, ownerID, "member", owner)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("self-demoting the last owner: got %d %s, want 409", resp.StatusCode, body)
	}
	if !strings.Contains(body, "no owner") {
		t.Fatalf("the refusal does not say why: %s", body)
	}
	resp, body = removeMember(t, srv, slug, ownerID, owner)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("removing the last owner: got %d %s, want 409", resp.StatusCode, body)
	}
	// Server-side, not merely hidden in the UI: the roster still shows them.
	if got := rolesOf(t, srv, slug, owner)[ownerID]; got != "owner" {
		t.Fatalf("the last owner lost the space anyway: role = %q", got)
	}
}

func TestRemovalRevokesAccessOnTheNextRequest(t *testing.T) {
	srv := testServer(t)
	slug, owner, _, member, memberID := spaceWithTwo(t, srv)

	// Before: a member sees the roster.
	if _, body := getSpace(t, srv, slug, member); body["members"] == nil {
		t.Fatal("the member could not see the roster before removal")
	}

	if resp, body := removeMember(t, srv, slug, memberID, owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove: got %d %s", resp.StatusCode, body)
	}

	// After, on the very next request: back to the stranger view, which is
	// what puts them in front of the passcode gate again.
	_, body := getSpace(t, srv, slug, member)
	if body["members"] != nil {
		t.Fatal("a removed member still reads the roster — removal did not revoke access")
	}
	if body["passcode"] != nil {
		t.Fatal("a removed member still reads the room code")
	}
	if body["protected"] != true {
		t.Fatalf("the space stopped looking protected to a removed member: %v", body)
	}
	// And they cannot create a session in it any more.
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/sessions",
		strings.NewReader(`{"kind":"poker","title":"After removal"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(member)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("a removed member created a session: got %d", resp.StatusCode)
	}
}

func TestMembershipRoutesValidateTheirInput(t *testing.T) {
	srv := testServer(t)
	slug, owner, _, _, memberID := spaceWithTwo(t, srv)

	if resp, body := setRole(t, srv, slug, memberID, "admin", owner); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown role: got %d %s, want 400", resp.StatusCode, body)
	}
	// A user id that is not a member of this space is not found, not a 500.
	outsider, outsiderID := signupWithID(t, srv, "Outsider")
	_ = outsider
	if resp, body := setRole(t, srv, slug, outsiderID, "owner", owner); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("promoting a non-member: got %d %s, want 404", resp.StatusCode, body)
	}
	if resp, body := removeMember(t, srv, slug, outsiderID, owner); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("removing a non-member: got %d %s, want 404", resp.StatusCode, body)
	}
	// A malformed id must not reach the database as one.
	if resp, body := removeMember(t, srv, slug, "not-a-uuid", owner); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("removing a malformed id: got %d %s, want 404", resp.StatusCode, body)
	}
}

func TestARemovedMemberCanRejoinWithTheRoomCode(t *testing.T) {
	srv := testServer(t)
	owner, _ := signupWithID(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Rejoin "+randomName(t), owner)
	slug, _ := sp["slug"].(string)
	passcode, _ := sp["passcode"].(string)
	member, memberID := signupWithID(t, srv, "Bob")
	joinSpace(t, srv, slug, member, passcode)

	if resp, body := removeMember(t, srv, slug, memberID, owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove: got %d %s", resp.StatusCode, body)
	}
	// Removal is not a ban: the passcode gate is the door, and they must be
	// made to knock on it again rather than walk straight back in.
	if resp := joinSpace(t, srv, slug, member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("rejoining without the code: got %d, want 403", resp.StatusCode)
	}
	if resp := joinSpace(t, srv, slug, member, passcode); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("rejoining with the code: got %d", resp.StatusCode)
	}
	if got := rolesOf(t, srv, slug, owner)[memberID]; got != "member" {
		t.Fatalf("role after rejoining = %q, want member", got)
	}
}

// TestRemovingAMemberClosesTheirOpenWebSocket is the socket half of "removal
// takes effect immediately". Membership is re-read on every HTTP request, but
// a WebSocket that is already open never makes another one: without an
// explicit disconnect the removed member keeps reading and writing live room
// state indefinitely. Drop the DisconnectSpaceMember call in
// handleRemoveMember and this test hangs on the read and fails.
func TestRemovingAMemberClosesTheirOpenWebSocket(t *testing.T) {
	srv := testServer(t)
	slug, owner, _, member, memberID := spaceWithTwo(t, srv)

	_, sess := createSession(t, srv, slug, "poker", "Live round", owner)
	sessionID, _ := sess["id"].(string)
	if sessionID == "" {
		t.Fatalf("no session id: %v", sess)
	}

	ws, _, err := dialWS(t, srv, sessionID, member, "")
	if err != nil {
		t.Fatalf("member could not open a socket: %v", err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 2*time.Second); !ok {
		t.Fatal("no initial envelope on the member's socket")
	}

	if resp, body := removeMember(t, srv, slug, memberID, owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove = %d %s, want 204", resp.StatusCode, body)
	}

	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("the removed member's websocket stayed open and kept receiving room state")
	} else if closeErr, ok := err.(*websocket.CloseError); !ok || closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("close on removal = %v, want policy violation", err)
	}

	// And the door stays shut: a reconnect fails the handshake's membership
	// check the same way a stranger's would.
	if reconnect, _, err := dialWS(t, srv, sessionID, member, ""); err == nil {
		reconnect.Close()
		t.Fatal("a removed member reconnected to the session socket")
	}
}

// TestRemovingAMemberLeavesEveryoneElseConnected keeps the disconnect narrow:
// it is scoped to one (space, user) pair, not a room-wide kick.
func TestRemovingAMemberLeavesEveryoneElseConnected(t *testing.T) {
	srv := testServer(t)
	slug, owner, _, member, memberID := spaceWithTwo(t, srv)

	_, sess := createSession(t, srv, slug, "poker", "Live round", owner)
	sessionID, _ := sess["id"].(string)

	ownerWS, _, err := dialWS(t, srv, sessionID, owner, "")
	if err != nil {
		t.Fatalf("owner could not open a socket: %v", err)
	}
	defer ownerWS.Close()
	memberWS, _, err := dialWS(t, srv, sessionID, member, "")
	if err != nil {
		t.Fatalf("member could not open a socket: %v", err)
	}
	defer memberWS.Close()
	readEnvelope(t, ownerWS, 2*time.Second)
	readEnvelope(t, memberWS, 2*time.Second)

	if resp, body := removeMember(t, srv, slug, memberID, owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove = %d %s, want 204", resp.StatusCode, body)
	}

	// The roster changed, so the owner's socket keeps working and keeps
	// getting state.
	if _, ok := readEnvelope(t, ownerWS, 2*time.Second); !ok {
		t.Fatal("the owner's websocket was closed by removing somebody else")
	}
}
