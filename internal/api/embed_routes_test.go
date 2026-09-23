package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/principal"
	"github.com/lets-parley/parley/internal/store"
)

// embedRouteClass is what an embedded session gets from one route.
type embedRouteClass int

const (
	// embedAllowed: the allow-list lets an embedded session through, and the
	// route's own authorization then applies exactly as for a cookie.
	embedAllowed embedRouteClass = iota
	// embedRefused: 403 from the allow-list gate, whoever holds the token.
	embedRefused
	// embedOutside: not under /api or /ws, so a bearer is never read there and
	// an embedded token gets exactly what an anonymous caller gets.
	embedOutside
)

// embeddedRouteTable classifies every registered route for an embedded
// session. It is written out by hand, independently of the gate's own
// allow-list, and TestEmbeddedRouteTable fails on any route missing from it —
// so a new route is not mergeable until somebody has decided whether a
// meeting's side panel needs it.
//
// The rule: read your identity and sign out, list and read the spaces and
// rooms you can already see, join a space with its passcode, read a room and
// take part in it, and the socket. Everything that administers, configures,
// mints a credential or reshapes an identity is refused.
var embeddedRouteTable = map[string]embedRouteClass{
	"GET /healthz":                    embedOutside,
	"GET /version":                    embedOutside,
	"GET /readyz":                     embedOutside,
	"GET /metrics":                    embedOutside,
	"GET /auth/login":                 embedOutside,
	"GET /auth/callback":              embedOutside,
	"GET /embed/signin":               embedOutside,
	"POST /embed/signin":              embedOutside,
	"GET /embed/*":                    embedOutside,
	"POST /embed/*":                   embedOutside,
	"GET /plugin-ui/{name}/{version}": embedOutside,
	"GET /ics/{token}":                embedOutside,
	"GET /s/{slug}":                   embedOutside,

	"GET /ws": embedAllowed,

	"GET /api/auth":           embedAllowed,
	"POST /api/embed/handoff": embedAllowed,
	"POST /api/embed/session": embedAllowed,
	"GET /api/embed/*":        embedAllowed,
	"POST /api/embed/*":       embedAllowed,

	"GET /api/me":            embedAllowed,
	"DELETE /api/me":         embedAllowed,
	"POST /api/me":           embedRefused,
	"PATCH /api/me/avatar":   embedRefused,
	"PATCH /api/me/settings": embedRefused,
	"GET /api/me/ics":        embedRefused,
	"POST /api/me/ics":       embedRefused,
	"DELETE /api/me/ics":     embedRefused,
	// Away days are the account's own and count in every space's standups,
	// not one room's, so they stay with the account's other settings.
	"GET /api/me/away":         embedRefused,
	"POST /api/me/away":        embedRefused,
	"DELETE /api/me/away/{id}": embedRefused,
	"POST /api/links/redeem":   embedRefused,

	"GET /api/orgs":                      embedAllowed,
	"GET /api/spaces":                    embedAllowed,
	"POST /api/spaces":                   embedRefused,
	"GET /api/orgs/{org}/spaces":         embedAllowed,
	"GET /api/orgs/{org}/plugins/panels": embedRefused,
	"GET /api/orgs/{org}/spaces/{slug}":  embedAllowed,

	"POST /api/orgs/{org}/spaces/{slug}/join":        embedAllowed,
	"POST /api/orgs/{org}/spaces/{slug}/invite":      embedRefused,
	"POST /api/orgs/{org}/spaces/{slug}/seen":        embedRefused,
	"POST /api/orgs/{org}/spaces/{slug}/passcode":    embedRefused,
	"POST /api/orgs/{org}/spaces/{slug}/sessions":    embedRefused,
	"PATCH /api/orgs/{org}/spaces/{slug}":            embedRefused,
	"DELETE /api/orgs/{org}/spaces/{slug}":           embedRefused,
	"PATCH /api/orgs/{org}/spaces/{slug}/visibility": embedRefused,

	"GET /api/orgs/{org}/spaces/{slug}/decks/":            embedRefused,
	"POST /api/orgs/{org}/spaces/{slug}/decks/":           embedRefused,
	"PATCH /api/orgs/{org}/spaces/{slug}/decks/{deckId}":  embedRefused,
	"DELETE /api/orgs/{org}/spaces/{slug}/decks/{deckId}": embedRefused,
	"GET /api/orgs/{org}/spaces/{slug}/kudos/":            embedRefused,
	"POST /api/orgs/{org}/spaces/{slug}/kudos/":           embedRefused,
	"DELETE /api/orgs/{org}/spaces/{slug}/kudos/{id}":     embedRefused,

	"GET /api/orgs/{org}/spaces/{slug}/standup-schedule/":   embedRefused,
	"PUT /api/orgs/{org}/spaces/{slug}/standup-schedule/":   embedRefused,
	"GET /api/orgs/{org}/spaces/{slug}/standup-trend":       embedRefused,
	"GET /api/orgs/{org}/spaces/{slug}/standup-webhook/":    embedRefused,
	"PUT /api/orgs/{org}/spaces/{slug}/standup-webhook/":    embedRefused,
	"DELETE /api/orgs/{org}/spaces/{slug}/standup-webhook/": embedRefused,

	"POST /api/orgs/{org}/spaces/{slug}/members/{userId}/role": embedRefused,
	"DELETE /api/orgs/{org}/spaces/{slug}/members/{userId}/":   embedRefused,
	"PATCH /api/orgs/{org}/spaces/{slug}/sessions/{id}/":       embedRefused,
	"DELETE /api/orgs/{org}/spaces/{slug}/sessions/{id}/":      embedRefused,

	"DELETE /api/orgs/{org}/":                             embedRefused,
	"GET /api/orgs/{org}/admin/spaces":                    embedRefused,
	"PATCH /api/orgs/{org}/admin/spaces/{slug}":           embedRefused,
	"DELETE /api/orgs/{org}/admin/spaces/{slug}":          embedRefused,
	"POST /api/orgs/{org}/admin/spaces/{slug}/owners":     embedRefused,
	"POST /api/orgs/{org}/admin/spaces/{slug}/claim":      embedRefused,
	"GET /api/orgs/{org}/admin/plugins/":                  embedRefused,
	"POST /api/orgs/{org}/admin/plugins/":                 embedRefused,
	"POST /api/orgs/{org}/admin/plugins/preview":          embedRefused,
	"POST /api/orgs/{org}/admin/plugins/{id}/upgrade":     embedRefused,
	"POST /api/orgs/{org}/admin/plugins/{id}/enabled":     embedRefused,
	"DELETE /api/orgs/{org}/admin/plugins/{id}":           embedRefused,
	"POST /api/orgs/{org}/admin/plugins/themes":           embedRefused,
	"DELETE /api/orgs/{org}/admin/plugins/themes":         embedRefused,
	"GET /api/orgs/{org}/admin/members":                   embedRefused,
	"POST /api/orgs/{org}/admin/members/{userId}/role":    embedRefused,
	"DELETE /api/orgs/{org}/admin/members/{userId}":       embedRefused,
	"POST /api/orgs/{org}/admin/members/{userId}/restore": embedRefused,

	// The room: reading it and taking part in it, the same participate set a
	// link guest is given. The dispatcher is allowed on every method, because
	// it — not the gate — decides 404-vs-405.
	"GET /api/sessions/{id}/":                     embedAllowed,
	"GET /api/sessions/{id}/plugins/panels":       embedAllowed,
	"POST /api/sessions/{id}/actions/{action}":    embedAllowed,
	"GET /api/sessions/{id}/actions/{action}":     embedAllowed,
	"HEAD /api/sessions/{id}/actions/{action}":    embedAllowed,
	"PUT /api/sessions/{id}/actions/{action}":     embedAllowed,
	"PATCH /api/sessions/{id}/actions/{action}":   embedAllowed,
	"DELETE /api/sessions/{id}/actions/{action}":  embedAllowed,
	"QUERY /api/sessions/{id}/actions/{action}":   embedAllowed,
	"CONNECT /api/sessions/{id}/actions/{action}": embedAllowed,
	"OPTIONS /api/sessions/{id}/actions/{action}": embedAllowed,
	"TRACE /api/sessions/{id}/actions/{action}":   embedAllowed,

	// The caller's own standup mentions, which the room reads per caller
	// because the broadcast is everyone's; asking is a dispatcher action.
	"GET /api/sessions/{id}/mentions": embedAllowed,

	"POST /api/sessions/{id}/spectator":                    embedRefused,
	"GET /api/sessions/{id}/export.csv":                    embedRefused,
	"POST /api/sessions/{id}/facilitator/claim":            embedRefused,
	"POST /api/sessions/{id}/facilitator":                  embedRefused,
	"POST /api/sessions/{id}/participants/{userId}/remove": embedRefused,
	"DELETE /api/sessions/{id}/":                           embedRefused,
	"POST /api/sessions/{id}/reopen":                       embedRefused,
	"GET /api/sessions/{id}/links":                         embedRefused,
	"POST /api/sessions/{id}/links":                        embedRefused,
	"DELETE /api/sessions/{id}/links/{linkId}":             embedRefused,
}

// embedCall is one request's status and, when it has one, its JSON error.
type embedCall struct {
	status int
	err    string
}

func (c embedCall) refusedAsEmbedded() bool {
	return c.status == http.StatusForbidden && c.err == embeddedRefusalMessage
}

func callRoute(t *testing.T, srv *httptest.Server, method, path, body, bearer string, cookie *http.Cookie) embedCall {
	t.Helper()
	req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		Error string `json:"error"`
	}
	json.Unmarshal(raw, &out)
	return embedCall{status: resp.StatusCode, err: out.Error}
}

func TestEmbeddedRouteTable(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{AllowedOrigin: testOrigin, MetricsEnabled: true, EmbedProviders: []EmbedProvider{testMeet}})
	// Fay owns the space and facilitates the room, so a cookie request from
	// her is the strongest control: whatever she is refused below is refused
	// for being embedded, not for lacking a role.
	fac, member, id := setupSession(t, srv, "Embed Route Space")
	story := addStory(t, srv, id, "Story", fac)
	selectStory(t, srv, id, story, fac)
	_, sess := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	slug, _ := sess["spaceSlug"].(string)
	mintLink(t, srv, id, fac)
	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	linkID := list["links"].([]any)[0].(map[string]any)["id"].(string)
	_, me := doJSON(t, srv, "GET", "/api/me", "", member)
	memberID, _ := me["id"].(string)

	token := embedToken(t, srv, fac)
	// DELETE /api/me spends the token it is called with, so it gets its own.
	leaver := embedToken(t, srv, fac)

	replace := strings.NewReplacer(
		"{id}", id,
		"{org}", store.DefaultOrgSlug,
		"{slug}", slug,
		"{action}", "vote",
		"{linkId}", linkID,
		"{userId}", memberID,
		"{deckId}", "00000000-0000-0000-0000-000000000000",
		"{name}", "none",
		"{version}", "0",
		"{token}", "none",
	)
	bodyFor := func(method, route string) string {
		if route == "/api/sessions/{id}/actions/{action}" && method == http.MethodPost {
			return `{"storyId":"` + story + `","value":"5"}`
		}
		switch method {
		case http.MethodPost, http.MethodPut, http.MethodPatch:
			return "{}"
		}
		return ""
	}

	routes, ok := srv.Config.Handler.(*Handler).Handler.(chi.Routes)
	if !ok {
		t.Fatal("router is not walkable")
	}
	type refusal struct{ method, path, body string }
	var refused []refusal
	seen := map[string]bool{}
	err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if route == "/*" {
			return nil // the SPA fallback
		}
		key := method + " " + route
		seen[key] = true
		class, classified := embeddedRouteTable[key]
		if !classified {
			t.Errorf("route %q is not classified in embeddedRouteTable — decide whether an embedded session may reach it", key)
			return nil
		}
		if key == "GET /ws" {
			return nil // TestEmbedWebSocketSubprotocol
		}
		path := replace.Replace(strings.TrimSuffix(route, "/"))
		body := bodyFor(method, route)
		switch class {
		case embedAllowed:
			bearer := token
			if key == "DELETE /api/me" {
				bearer = leaver
			}
			if got := callRoute(t, srv, method, path, body, bearer, nil); got.refusedAsEmbedded() {
				t.Errorf("%s: an allowed route refused the embedded session", key)
			}
		case embedRefused:
			got := callRoute(t, srv, method, path, body, token, nil)
			if !got.refusedAsEmbedded() {
				t.Errorf("%s with an embedded bearer: got %d %q, want 403 %q", key, got.status, got.err, embeddedRefusalMessage)
			}
			refused = append(refused, refusal{method, path, body})
		case embedOutside:
			anon := callRoute(t, srv, method, path, body, "", nil)
			if got := callRoute(t, srv, method, path, body, token, nil); got.status != anon.status {
				t.Errorf("%s: a bearer changed the answer outside /api (%d, anonymous %d)", key, got.status, anon.status)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for key := range embeddedRouteTable {
		if !seen[key] {
			t.Errorf("embeddedRouteTable classifies %q, which is no longer a route", key)
		}
	}

	// The positive control, run after every refusal so the writes it lets
	// through cannot change what the refusals saw: the same person, the same
	// memberships, carried by a cookie, is never turned away for being
	// embedded. A refusal the cookie shares would prove nothing.
	for _, rq := range refused {
		if got := callRoute(t, srv, rq.method, rq.path, rq.body, "", fac); got.refusedAsEmbedded() {
			t.Errorf("control: %s %s with the same person's cookie was refused as embedded", rq.method, rq.path)
		}
	}
	// And the gate is still open where it should be after all of that.
	if got := callRoute(t, srv, "GET", "/api/me", "", token, nil); got.status != http.StatusOK {
		t.Errorf("GET /api/me with the embedded token after the walk: %d", got.status)
	}
}

// TestRequireOrgAdminRefusesAnEmbeddedAdmin is the second lock behind the
// allow-list: even a request that reached the admin set with an embedded
// principal, and an admin's role in hand, is refused.
func TestRequireOrgAdminRefusesAnEmbeddedAdmin(t *testing.T) {
	a := &app{}
	reached := false
	h := a.requireOrgAdmin(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
	for _, embedded := range []bool{false, true} {
		reached = false
		ctx := principal.With(context.Background(), Principal{UserID: "u", Embedded: embedded})
		ctx = context.WithValue(ctx, orgRoleKey{}, store.OrgRoleAdmin)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil).WithContext(ctx))
		if embedded && (reached || rec.Code != http.StatusForbidden) {
			t.Errorf("an embedded admin reached the admin set: %d", rec.Code)
		}
		if !embedded && !reached {
			t.Errorf("control: a cookie admin was refused: %d", rec.Code)
		}
	}
}
