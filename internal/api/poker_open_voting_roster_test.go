package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lets-parley/parley/internal/store"
)

// RemoveMember prunes round_voters for the current story, but the removed
// person can still sit in session_participants. Selecting a new story (or
// reset) re-runs snapshotVoters from that table; if the snapshot does not
// require current membership, the departed person is recorded again, cannot
// vote, and wedges auto-reveal for every subsequent round.
func TestOpenRoundDoesNotReWaitForRemovedMemberAfterResnapshot(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Resnapshot Space")
	leaver, leaverID := signupWithID(t, srv, "Lou")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/open-resnapshot-space", "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, "open-resnapshot-space", leaver, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join leaver: %d", resp.StatusCode)
	}
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	joinRoom(t, srv, id, leaver)

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	first := addStory(t, srv, id, "First story", fac)
	selectStory(t, srv, id, first, fac)

	if resp, body := doJSON(t, srv, "DELETE",
		"/api/orgs/default/spaces/open-resnapshot-space/members/"+leaverID, "", fac); resp.StatusCode >= 300 {
		t.Fatalf("remove member: %d (%v)", resp.StatusCode, body)
	}

	second := addStory(t, srv, id, "Second story", fac)
	selectStory(t, srv, id, second, fac)

	if resp := vote(t, srv, id, second, "3", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("facilitator vote: %d", resp.StatusCode)
	}
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed with one of two remaining votes")
	}
	if resp := vote(t, srv, id, second, "5", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("member vote: %d", resp.StatusCode)
	}
	if !revealed(t, srv, id, fac) {
		t.Fatal("a member removed before the new story was selected wedged auto-reveal after re-snapshot")
	}
}

// Same shape via reset on the story already on the table: reset re-takes the
// roster, and must not put a departed member back into the pending set.
func TestOpenRoundDoesNotReWaitForRemovedMemberAfterReset(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Open Reset Resnapshot Space")
	leaver, leaverID := signupWithID(t, srv, "Lou")
	_, sp := doJSON(t, srv, "GET", "/api/orgs/default/spaces/open-reset-resnapshot-space", "", fac)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, "open-reset-resnapshot-space", leaver, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join leaver: %d", resp.StatusCode)
	}
	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	joinRoom(t, srv, id, leaver)

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Reset story", fac)
	selectStory(t, srv, id, story, fac)

	if resp, body := doJSON(t, srv, "DELETE",
		"/api/orgs/default/spaces/open-reset-resnapshot-space/members/"+leaverID, "", fac); resp.StatusCode >= 300 {
		t.Fatalf("remove member: %d (%v)", resp.StatusCode, body)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reset", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reset: %d", resp.StatusCode)
	}

	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed with one of two remaining votes")
	}
	vote(t, srv, id, story, "5", member)
	if !revealed(t, srv, id, fac) {
		t.Fatal("a member removed before reset wedged auto-reveal after the roster was re-taken")
	}
}

// Org-admin RevokeOrgMember deletes the members row but historically left
// round_voters untouched. Mel can no longer vote; everybody else voting must
// still complete the round.
func TestOpenRoundStopsWaitingAfterOrgRevoke(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "Open Org Revoke Space")
	_, me := doJSON(t, srv, "GET", "/api/me", "", member)
	memberID, _ := me["id"].(string)
	if memberID == "" {
		t.Fatalf("no user id for Mel: %v", me)
	}
	admin, adminID := signupWithID(t, srv, "OrgAdmin")
	makeOrgAdmin(t, pool, adminID)

	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "Org revoke story", fac)
	selectStory(t, srv, id, story, fac)

	vote(t, srv, id, story, "3", fac)
	if revealed(t, srv, id, fac) {
		t.Fatal("open round revealed while Mel was still expected")
	}

	if resp, body := doJSON(t, srv, "DELETE",
		custodyPath+"/members/"+memberID, "", admin); resp.StatusCode >= 300 {
		t.Fatalf("org revoke: %d (%v)", resp.StatusCode, body)
	}

	vote(t, srv, id, story, "3", fac)
	if !revealed(t, srv, id, fac) {
		t.Fatal("an org revoke left Mel in the pending set and wedged auto-reveal")
	}
}

// A remote replica keeps the removed member's socket until revalidation (up to
// 30s). If attach-time Join failed, that socket's pong retries OnJoin; without
// an eligibility re-check it re-inserts them into session_participants, and
// the next open-voting snapshot waits for a person who can never vote.
func TestPongRetryDoesNotReinsertRemovedMember(t *testing.T) {
	pool := testPool(t)
	handler := Router(pool, Options{AllowedOrigin: testOrigin, Context: testContext(t)})
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})

	fac, member, id := setupSession(t, srv, "Pong Retry Reinsert Space")
	leaver, leaverID := signupWithID(t, srv, "Lou")
	_, spBody := doJSON(t, srv, "GET", "/api/orgs/default/spaces/pong-retry-reinsert-space", "", fac)
	code, _ := spBody["passcode"].(string)
	if resp := joinSpace(t, srv, "pong-retry-reinsert-space", leaver, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join leaver: %d", resp.StatusCode)
	}
	var spaceID string
	if err := pool.QueryRow(context.Background(),
		`select id::text from spaces where slug = 'pong-retry-reinsert-space'`).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}

	var leaverJoins atomic.Int32
	innerJoin := handler.hub.OnJoin
	handler.hub.OnJoin = func(sessionID, userID string) error {
		if userID == leaverID {
			if leaverJoins.Add(1) == 1 {
				return fmt.Errorf("transient attach failure")
			}
		}
		return innerJoin(sessionID, userID)
	}

	joinRoom(t, srv, id, fac)
	joinRoom(t, srv, id, member)
	leaverWS := joinRoom(t, srv, id, leaver)
	if n := leaverJoins.Load(); n != 1 {
		t.Fatalf("leaver OnJoin on attach = %d, want 1 (failed)", n)
	}

	// Simulate the remote-replica window: membership is gone and participants
	// are pruned, but this process has not yet torn the socket down.
	if err := (&store.Spaces{Pool: pool}).RemoveMember(context.Background(), spaceID, leaverID); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}

	if err := leaverWS.WriteControl(websocket.PongMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	var stillThere bool
	if err := pool.QueryRow(context.Background(),
		`select exists (select 1 from session_participants where session_id = $1 and user_id = $2)`,
		id, leaverID).Scan(&stillThere); err != nil {
		t.Fatal(err)
	}
	if stillThere {
		t.Fatal("pong retry re-inserted a removed member into session_participants")
	}

	setConfig(t, srv, id, `{"autoReveal":true,"openVoting":true}`, fac)
	story := addStory(t, srv, id, "After pong", fac)
	selectStory(t, srv, id, story, fac)
	if resp := vote(t, srv, id, story, "3", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("facilitator vote: %d", resp.StatusCode)
	}
	if resp := vote(t, srv, id, story, "5", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("member vote: %d", resp.StatusCode)
	}
	if !revealed(t, srv, id, fac) {
		t.Fatal("a pong-retry ghost in session_participants wedged open-voting auto-reveal")
	}
}
