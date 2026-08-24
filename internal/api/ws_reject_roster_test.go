package api

import (
	"context"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"
)

// TestRejectedPrincipalNeverReachesAnotherClientsRoster is the end-to-end half
// of the guarantee #315 fixed in the hub: a principal the post-registration
// membership re-check rejects must never appear in the roster another client
// actually receives.
//
// TestRejectedMembershipRecordsNoPresence (internal/hub) pins the proxy for
// that — OnFacilitatorSeen is never called — but the hub does not build
// envelopes, so nothing there joins "no presence row was written" to "the
// roster other people see omits them". RedactForGuest filters Participants to
// presence ∪ facilitator ∪ self, and that composition lives in
// internal/session; a refactor of it, or a second path into Participants,
// would leave the hub assertion green.
//
// The rejected principal here is a real space member, so the HTTP handler
// admits the socket exactly as it would in production and the roster the
// database returns still names him: the only thing keeping him out of the
// frame Gus receives is that no presence row was written for him. The hub's
// re-check is what rejects him, standing in for the removal landing between
// registration and that check.
//
// The check is held open rather than returning straight away, which is what
// makes the ordering it pins observable: with the presence write moved back
// ahead of confirmMembership, the row exists for as long as the check is
// blocked, instead of for the unpredictable sliver before teardown clears it.
func TestRejectedPrincipalNeverReachesAnotherClientsRoster(t *testing.T) {
	pool := testPool(t)
	handler := Router(pool, Options{AllowedOrigin: testOrigin, Context: testContext(t)})
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})

	fac, member, id := setupSession(t, srv, "Rejected Roster Space")
	_, minted := mintLink(t, srv, id, fac)
	token, _ := minted["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", minted)
	}
	gus := redeemAs(t, srv, token, "Gus")

	_, facMe := doJSON(t, srv, "GET", "/api/me", "", fac)
	facID := facMe["id"].(string)
	_, memberMe := doJSON(t, srv, "GET", "/api/me", "", member)
	memberID := memberMe["id"].(string)

	// The connection is registered only after a first membership check, so
	// the rejection has to land on the second one — which is exactly the
	// removal this pins: a member at registration, gone by the time the
	// post-registration re-check reads the row again. The re-check is held
	// open so the window it guards is observable rather than a sliver.
	reached, release := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	var once sync.Once
	checks := 0
	inner := handler.hub.ValidateMembership
	handler.hub.ValidateMembership = func(ctx context.Context, sessionID, spaceID, userID string) (bool, error) {
		if userID != memberID {
			return inner(ctx, sessionID, spaceID, userID)
		}
		mu.Lock()
		checks++
		first := checks == 1
		mu.Unlock()
		if first {
			return inner(ctx, sessionID, spaceID, userID)
		}
		once.Do(func() { close(reached) })
		select {
		case <-release:
		case <-ctx.Done():
		}
		return false, nil
	}
	defer close(release)

	// Gus is the second client: a link guest, so the frames it receives are
	// the redacted copy, which is where the roster rule under test lives.
	gusWS, _, err := dialWS(t, srv, id, gus, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer gusWS.Close()
	if _, ok := readEnvelope(t, gusWS, 3*time.Second); !ok {
		t.Fatal("no initial frame for the guest")
	}

	// Mel's socket is admitted by the handler and then held inside the
	// membership re-check that will reject it.
	melWS, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer melWS.Close()
	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the membership re-check was never reached for the rejected member")
	}

	// The facilitator connecting is what forces a fresh broadcast out to Gus
	// while Mel is still parked in the re-check. Her own presence landing is
	// the sync point: she is on Gus's roster either way, as the facilitator.
	facWS, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer facWS.Close()
	if _, ok := readEnvelope(t, facWS, 3*time.Second); !ok {
		t.Fatal("no initial frame for the facilitator")
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		env, ok := readEnvelope(t, gusWS, time.Until(deadline))
		if !ok {
			t.Fatal("the guest never received a frame carrying the facilitator's presence")
		}
		if got := participantNames(t, env); slices.Contains(got, "Mel") {
			t.Fatalf("guest frame participants = %v: a principal rejected by the membership "+
				"re-check reached another client's roster", got)
		}
		present := []string{}
		for _, p := range env["presence"].([]any) {
			present = append(present, p.(string))
		}
		if slices.Contains(present, memberID) {
			t.Fatalf("guest frame presence = %v: the rejected member has a presence row", present)
		}
		if slices.Contains(present, facID) {
			break
		}
	}

	// And the same roster fetched over REST, which is the other way the guest
	// reads the room.
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", gus)
	if got := participantNames(t, env); slices.Contains(got, "Mel") {
		t.Fatalf("guest REST participants = %v, want the rejected member absent", got)
	}
}
