package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/poker"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/standup"
)

// linkGuestVerb is the table's own claim about one action verb.
//
// There are two independent facilitator gates in this codebase and the table
// pins both, because either one alone would hide the loss of the other:
//
//   - facilitatorOnly mirrors the dispatcher's session.Action.FacilitatorOnly
//     flag, which answers 403 before the handler runs. It is written out here
//     rather than read from the registry on purpose: reading it would make the
//     expectation follow the flag, so clearing the flag would silently rewrite
//     what the test asserts instead of failing it.
//   - refused is what a link guest actually gets. It is not implied by the
//     flag: poker's story edit carries no dispatcher flag and is still refused,
//     because store.WithActiveSession's own facilitator argument turns it away
//     inside the handler.
//
// body is what the guest has to send to reach the handler at all on a verb it
// is allowed.
type linkGuestVerb struct {
	facilitatorOnly bool
	refused         bool
	body            string
}

// linkGuestActionVerbs classifies every action verb every session kind
// registers, per kind, for a link guest. TestLinkGuestActionVerbs walks the
// kinds' own dispatch tables and fails on any verb missing from here, so
// registering a new action is not mergeable until somebody has decided whether
// a link guest may call it.
//
// The rule, epic decision D3: a link holder is never the facilitator, so every
// verb reserved for the facilitator — by the dispatcher flag or by the store
// layer — is refused with 403, and every other verb is a participate verb the
// guest may call like anybody else in the room.
//
// TestLinkGuestRouteTable covers the *route* `/api/sessions/{id}/actions/
// {action}` with one representative verb; this test covers the verbs behind it.
var linkGuestActionVerbs = map[string]map[string]linkGuestVerb{
	"poker": {
		"stories": {facilitatorOnly: true, refused: true},
		"select":  {facilitatorOnly: true, refused: true},
		"reveal":  {facilitatorOnly: true, refused: true},
		"reset":   {facilitatorOnly: true, refused: true},
		"vote":    {body: `{"storyId":"{storyId}","value":"5"}`},
		// No dispatcher flag, and refused anyway: applyPatch asks
		// store.WithActiveSession for the facilitator. Editing the backlog is
		// the facilitator's, so the outcome is right — but the flag and the
		// outcome disagree, and only a table that records both notices if
		// either half is dropped.
		"story": {refused: true, body: `{"storyId":"{storyId}","title":"Renamed"}`},
	},
	"standup": {
		// next and skip are literally the same handler, so behaviour alone
		// cannot tell them apart. They are enumerated separately anyway: the
		// point of the table is that a new verb forces a decision.
		"start":   {facilitatorOnly: true, refused: true},
		"next":    {facilitatorOnly: true, refused: true},
		"skip":    {facilitatorOnly: true, refused: true},
		"standup": {body: `{"yesterday":"a","today":"b","blockers":""}`},
		"ready":   {body: `{"ready":true}`},
	},
}

// TestLinkGuestActionVerbs is the verb-level half of the link authorization
// surface.
//
// What it asserts is the authorization *outcome*, not an exact status: a
// refused verb must answer exactly 403, while an allowed verb must merely reach
// its handler — anything but 401, 403, 404 or 405. A participate verb's exact
// status legitimately depends on the session phase (a standup entry is 204
// while the round is gathering and a poker vote is 204 only once a story is
// selected), so pinning one number here would make the guard flaky in exchange
// for telling us nothing extra about authorization.
func TestLinkGuestActionVerbs(t *testing.T) {
	for _, kind := range []session.Kind{poker.Kind(), standup.Kind()} {
		t.Run(kind.Name, func(t *testing.T) {
			srv := testServer(t)
			fac, id, guest := mintAndRedeemKind(t, srv, "Verb Table "+kind.Name, kind.Name)
			storyID := ""
			if kind.Name == "poker" {
				storyID = addStory(t, srv, id, "Story", fac)
				selectStory(t, srv, id, storyID, fac)
			}
			replace := strings.NewReplacer("{storyId}", storyID)

			want := linkGuestActionVerbs[kind.Name]
			for name, act := range kind.Actions {
				exp, classified := want[name]
				if !classified {
					t.Errorf("kind %q registers action %q, which is not classified in linkGuestActionVerbs — decide whether a link guest may call it", kind.Name, name)
					continue
				}
				if exp.facilitatorOnly != act.FacilitatorOnly {
					t.Errorf("kind %q action %q: registry says FacilitatorOnly=%v, linkGuestActionVerbs says %v — a link guest is never the facilitator, so changing that flag changes what a link guest may do",
						kind.Name, name, act.FacilitatorOnly, exp.facilitatorOnly)
					continue
				}
				path := "/api/sessions/" + id + "/actions/" + name
				got, err := requestStatus(srv, act.Verb, path, replace.Replace(exp.body), guest)
				if err != nil {
					t.Errorf("%s %s: %v", act.Verb, path, err)
					continue
				}
				if exp.refused {
					if got != http.StatusForbidden {
						t.Errorf("%s actions/%s as a link guest: got %d, want 403 — it is reserved for the facilitator", kind.Name, name, got)
					}
					continue
				}
				switch got {
				case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusMethodNotAllowed:
					t.Errorf("%s actions/%s as a link guest: got %d, want the handler reached — this is a participate verb", kind.Name, name, got)
				}
			}
			for name := range want {
				if _, ok := kind.Actions[name]; !ok {
					t.Errorf("linkGuestActionVerbs classifies %q for kind %q, which registers no such action", name, kind.Name)
				}
			}
		})
	}
}

// mintAndRedeemKind is mintAndRedeem for a session of a named kind.
func mintAndRedeemKind(t *testing.T, srv *httptest.Server, spaceName, kind string) (fac *http.Cookie, sessionID string, guest *http.Cookie) {
	t.Helper()
	fac = signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, spaceName, fac)
	resp, sess := createSession(t, srv, sp["slug"].(string), kind, "Room", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create %s session: %d %v", kind, resp.StatusCode, sess)
	}
	sessionID = sess["id"].(string)
	_, minted := mintLink(t, srv, sessionID, fac)
	token, _ := minted["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", minted)
	}
	r, body, guest := redeem(t, srv, token, "Gus")
	if r.StatusCode != http.StatusCreated || guest == nil {
		t.Fatalf("redeem: got %d (%v)", r.StatusCode, body)
	}
	return fac, sessionID, guest
}
