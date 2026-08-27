package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/store"
)

// linkRouteExpectation is what a link guest gets on one route: the status, and
// the body needed to reach the handler at all on the routes it is allowed.
type linkRouteExpectation struct {
	status int
	body   string
}

// linkGuestRouteTable is the whole authorization surface for a link principal,
// route by route, and it is deliberately exhaustive: TestLinkGuestRouteTable
// walks chi's registered routes and fails on any pattern missing from here. A
// new route is therefore not mergeable until somebody has decided what a link
// guest may do with it.
//
// The rule the table encodes: participate actions, reading the bound room, and
// reading its own identity — nothing else. Everything a link guest is refused
// answers 401, 403 or 404 — never 200 with less data, because a partial answer
// is still an answer.
var linkGuestRouteTable = map[string]linkRouteExpectation{
	// Infrastructure, identical for everyone and carrying nothing about any
	// room. These are the only non-4xx entries outside the bound session.
	"GET /healthz":       {status: http.StatusOK},
	"GET /version":       {status: http.StatusOK},
	"GET /readyz":        {status: http.StatusOK},
	"GET /api/auth":      {status: http.StatusOK},
	"GET /auth/login":    {status: http.StatusNotFound},
	"GET /auth/callback": {status: http.StatusNotFound},
	// The socket is not an HTTP status, so it is exercised by the WebSocket
	// tests instead: a guest connects to the bound room, and expiry and
	// revocation both sever it.
	"GET /ws": {status: statusExercisedElsewhere},
	// The redemption door itself, which is open to everyone by definition —
	// including someone who already holds a link. A second redemption buys
	// another identity bound to whichever room that token names, never a
	// wider one. With no token in the body it is simply a bad request.
	"POST /api/links/redeem": {status: http.StatusBadRequest},

	// Identity. A link guest may read its own — that is how a browser with no
	// local storage finds its way back into the room — but may not reshape it:
	// renaming itself is the escalation that would let it wear the
	// facilitator's name on the roster. The read carries only the guest's own
	// name, avatar and bound room; TestLinkGuestCanReadOwnIdentity pins the
	// field list so it stays that way.
	// Leaving is the exception to "identity is read-only for a guest": it
	// spends the credential rather than reshaping it, and it is the only way
	// a guest on a borrowed browser can stop the cookie outliving the visit.
	// It deletes the caller's own session_tokens row and nothing else.
	"POST /api/me":         {status: http.StatusForbidden},
	"GET /api/me":          {status: http.StatusOK},
	"DELETE /api/me":       {status: http.StatusNoContent},
	"PATCH /api/me/avatar": {status: http.StatusForbidden},

	// Orgs and spaces. A link is bound to one room, never a space, and never
	// the org around it, so none of this is visible.
	//
	// Every entry below kept the status its un-prefixed predecessor answered,
	// and the two mechanisms behind those statuses are not interchangeable.
	// The public space view answers 403 through rejectLinkPrincipal, which is
	// why it stays mounted with that middleware and outside RequireUser. The
	// list and the write routes answer 401 through RequireUser, which is why
	// RequireUser stays ahead of requireOrgMember on them — reversing the two
	// would turn those 401s into 404s. The owner routes answer 404, formerly
	// from requireSpaceOwner's slug lookup and now from requireOrgMember one
	// step earlier: a link guest belongs to no org.
	"GET /api/orgs":                                            {status: http.StatusUnauthorized},
	"GET /api/spaces":                                          {status: http.StatusUnauthorized},
	"POST /api/spaces":                                         {status: http.StatusUnauthorized},
	"GET /api/orgs/{org}/spaces/{slug}":                        {status: http.StatusForbidden},
	"PATCH /api/orgs/{org}/spaces/{slug}":                      {status: http.StatusNotFound},
	"DELETE /api/orgs/{org}/spaces/{slug}":                     {status: http.StatusNotFound},
	"POST /api/orgs/{org}/spaces/{slug}/join":                  {status: http.StatusUnauthorized},
	"POST /api/orgs/{org}/spaces/{slug}/seen":                  {status: http.StatusUnauthorized},
	"POST /api/orgs/{org}/spaces/{slug}/passcode":              {status: http.StatusUnauthorized},
	"POST /api/orgs/{org}/spaces/{slug}/sessions":              {status: http.StatusUnauthorized},
	"POST /api/orgs/{org}/spaces/{slug}/members/{userId}/role": {status: http.StatusNotFound},
	"DELETE /api/orgs/{org}/spaces/{slug}/members/{userId}/":   {status: http.StatusNotFound},
	"PATCH /api/orgs/{org}/spaces/{slug}/sessions/{id}/":       {status: http.StatusNotFound},
	"DELETE /api/orgs/{org}/spaces/{slug}/sessions/{id}/":      {status: http.StatusNotFound},

	// The bound room. Reading it and taking part in it is the whole grant.
	"GET /api/sessions/{id}/": {status: http.StatusOK},
	// The dispatcher is mounted for every method so that it, not chi, decides
	// 404-vs-405. This table classifies route *patterns*, so {action} here is
	// one representative name — voting, the participate capability — and every
	// other verb on the same action is simply the wrong verb. The action names
	// behind the pattern are enumerated per kind by TestLinkGuestActionVerbs;
	// this entry deliberately does not stand in for them.
	"POST /api/sessions/{id}/actions/{action}":    {status: http.StatusNoContent, body: `{"storyId":"{storyId}","value":"5"}`},
	"GET /api/sessions/{id}/actions/{action}":     {status: http.StatusMethodNotAllowed},
	"HEAD /api/sessions/{id}/actions/{action}":    {status: http.StatusMethodNotAllowed},
	"PUT /api/sessions/{id}/actions/{action}":     {status: http.StatusMethodNotAllowed},
	"PATCH /api/sessions/{id}/actions/{action}":   {status: http.StatusMethodNotAllowed},
	"DELETE /api/sessions/{id}/actions/{action}":  {status: http.StatusMethodNotAllowed},
	"QUERY /api/sessions/{id}/actions/{action}":   {status: http.StatusMethodNotAllowed},
	"CONNECT /api/sessions/{id}/actions/{action}": {status: http.StatusMethodNotAllowed},
	"OPTIONS /api/sessions/{id}/actions/{action}": {status: http.StatusMethodNotAllowed},
	"TRACE /api/sessions/{id}/actions/{action}":   {status: http.StatusMethodNotAllowed},

	// …and everything else inside it, each shut explicitly. Spectating is a
	// member flag with no row for a guest to write, so it is refused rather
	// than accepted as a lie.
	"POST /api/sessions/{id}/spectator":         {status: http.StatusForbidden},
	"GET /api/sessions/{id}/export.csv":         {status: http.StatusForbidden},
	"POST /api/sessions/{id}/facilitator/claim": {status: http.StatusForbidden},
	"POST /api/sessions/{id}/facilitator":       {status: http.StatusForbidden},
	"DELETE /api/sessions/{id}/":                {status: http.StatusForbidden},
	"POST /api/sessions/{id}/reopen":            {status: http.StatusForbidden},
	"GET /api/sessions/{id}/links":              {status: http.StatusForbidden},
	"POST /api/sessions/{id}/links":             {status: http.StatusForbidden},
	"DELETE /api/sessions/{id}/links/{linkId}":  {status: http.StatusForbidden},
}

// statusExercisedElsewhere marks a route whose answer is not an HTTP status.
const statusExercisedElsewhere = -1

func TestLinkGuestRouteTable(t *testing.T) {
	srv := testServer(t)
	fac, id, guest := mintAndRedeem(t, srv, "Route Table Space")

	// A story, selected, so the participate action the table exercises is a
	// real 204 rather than a 409 about there being nothing to vote on.
	story := addStory(t, srv, id, "Story", fac)
	selectStory(t, srv, id, story, fac)
	_, sess := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	slug, _ := sess["spaceSlug"].(string)
	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	linkID := list["links"].([]any)[0].(map[string]any)["id"].(string)
	_, me := doJSON(t, srv, "GET", "/api/me", "", fac)
	userID, _ := me["id"].(string)

	// DELETE /api/me spends the credential it is called with, so exercising
	// it with `guest` would make every route the walk reaches afterwards
	// answer for a signed-out caller instead of a link guest. It gets a second
	// guest of its own, and the walk's order stops mattering.
	_, minted := mintLink(t, srv, id, fac)
	r, body, leaver := redeem(t, srv, minted["token"].(string), "Lee")
	if r.StatusCode != http.StatusCreated || leaver == nil {
		t.Fatalf("redeem the second guest: got %d (%v)", r.StatusCode, body)
	}

	replace := strings.NewReplacer(
		"{id}", id,
		"{org}", store.DefaultOrgSlug,
		"{slug}", slug,
		"{action}", "vote",
		"{linkId}", linkID,
		"{userId}", userID,
		"{storyId}", story,
	)

	routes, ok := srv.Config.Handler.(*Handler).Handler.(chi.Routes)
	if !ok {
		t.Fatal("router is not walkable")
	}
	seen := map[string]bool{}
	err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		key := method + " " + route
		if route == "/*" {
			return nil // the SPA fallback, which serves the frontend to anyone.
		}
		seen[key] = true
		want, classified := linkGuestRouteTable[key]
		if !classified {
			t.Errorf("route %q is not classified in linkGuestRouteTable — decide what a link guest may do with it", key)
			return nil
		}
		if want.status == statusExercisedElsewhere {
			return nil
		}
		verb := method
		if verb == "*" {
			verb = http.MethodPost
		}
		path := replace.Replace(strings.TrimSuffix(route, "/"))
		if path == "" {
			path = "/"
		}
		cookie := guest
		if key == "DELETE /api/me" {
			cookie = leaver
		}
		got, err := requestStatus(srv, verb, path, replace.Replace(want.body), cookie)
		if err != nil {
			t.Errorf("%s: %v", key, err)
			return nil
		}
		if got != want.status {
			t.Errorf("%s as a link guest: got %d, want %d", key, got, want.status)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for key := range linkGuestRouteTable {
		if !seen[key] {
			t.Errorf("linkGuestRouteTable classifies %q, which is no longer a route", key)
		}
	}
}
