package api

import (
	"net/http"
	"testing"
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
