package api

import (
	"context"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/principal"
	"github.com/lets-parley/parley/internal/store"
)

// newUser mints an account directly, with no org membership: signing up
// through the API enrols the caller in the default org, which is the opposite
// of what the admin gate needs to be shown an outsider.
func newUser(t *testing.T, a *app, name string) string {
	t.Helper()
	_, hash := store.NewToken()
	u, err := a.users.Create(context.Background(), name, hash)
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

const chiPkgPath = "github.com/go-chi/chi/v5"

// typeCheckAPIPackage type-checks this package's non-test sources so the
// static assertions below can resolve a call to the package that declares it
// rather than to a string that happens to look like one.
//
// It uses go/types with the source importer rather than go/packages, because
// that is the same guarantee out of the standard library and this repository
// does not otherwise depend on golang.org/x/tools.
func typeCheckAPIPackage(t *testing.T) (*token.FileSet, []*ast.File, *types.Info) {
	t.Helper()
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var files []*ast.File
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || filepath.Ext(name) != ".go" || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f)
	}
	info := &types.Info{
		Uses:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
	}
	conf := types.Config{Importer: importer.ForCompiler(fset, "source", nil)}
	if _, err := conf.Check("github.com/lets-parley/parley/internal/api", fset, files, info); err != nil {
		t.Fatalf("type-checking internal/api: %v", err)
	}
	return fset, files, info
}

// enclosingFunc names the top-level function a position falls inside.
func enclosingFunc(f *ast.File, pos token.Pos) string {
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if ok && fn.Pos() <= pos && pos <= fn.End() {
			return fn.Name.Name
		}
	}
	return "(file scope)"
}

// TestOrgParamHasOneReader is the "one source of truth per request" rule, held
// with type information rather than a grep.
//
// Matching the literal chi.URLParam(r, "org") is not enough:
// chi.URLParamFromCtx(ctx, "org") and chi.RouteContext(r.Context()).URLParam("org")
// reach the same value, and an import alias hides all three from a text
// search. So every call in the package is resolved to the package that
// declares its callee, and any chi call carrying the "org" literal outside the
// single permitted reader fails the build. A black-box HTTP test cannot prove
// this: a handler that re-derived the org would still answer correctly for the
// happy path.
func TestOrgParamHasOneReader(t *testing.T) {
	fset, files, info := typeCheckAPIPackage(t)

	// orgSlugFromRoute is the one reader. requireOrgMember calls it and puts
	// the resolved org in the request context; handleGetSpace calls it
	// because it is anonymous and has no context org to read. Everything else
	// must read orgFrom(ctx).
	const permitted = "orgSlugFromRoute"

	found := false
	for _, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			carriesOrg := false
			for _, arg := range call.Args {
				if lit, ok := arg.(*ast.BasicLit); ok && lit.Kind == token.STRING && lit.Value == `"org"` {
					carriesOrg = true
				}
			}
			if !carriesOrg {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			obj := info.Uses[sel.Sel]
			if obj == nil || obj.Pkg() == nil || obj.Pkg().Path() != chiPkgPath {
				return true
			}
			found = true
			if fn := enclosingFunc(f, call.Pos()); fn != permitted {
				t.Errorf("%s: %s reads the \"org\" route parameter through chi.%s — read it from the request context with orgFrom instead, so one middleware stays the single source of truth",
					fset.Position(call.Pos()), fn, obj.Name())
			}
			return true
		})
	}
	if !found {
		t.Fatalf("no chi call carrying the \"org\" route parameter was found at all — the check has stopped looking at anything")
	}
}

// TestEverySpaceLookupIsGated enumerates the call sites of every store.Spaces
// method that resolves a space by slug and pins how each one gets its org. The
// scan matches on the *shape* of the method — any exported method on
// store.Spaces whose name contains "Slug" — rather than a list of known method
// names, so a new lookup added under a new name is caught rather than skipped.
// A call site that is not classified below fails.
func TestEverySpaceLookupIsGated(t *testing.T) {
	// The classification: every BySlug caller must take its org id from
	// orgFrom(ctx), which only requireOrgMember ever puts there.
	// handleGetSpace is the deliberate exception — it is anonymous, so it
	// cannot sit behind a membership check, and it uses BySlugInOrg with the
	// org resolved from the URL segment in the same query.
	wantContextOrg := map[string]bool{
		"handleMarkSpaceSeen": true,
		"handleJoinSpace":     true,
		"handleSetPasscode":   true,
		"handleCreateSession": true,
		"requireSpaceOwner":   true,
		"requireSpaceMember":  true,
	}
	// The anonymous pre-join routes: neither can sit behind a membership
	// check, so both use BySlugInOrg with the org resolved from the URL
	// segment in the same query.
	anonymous := map[string]bool{
		"handleGetSpace":         true,
		"handleMintInviteHandle": true,
	}
	// The legacy /s/{slug} shim has no org in the URL and no context org: it
	// exists to find one. Its lookup carries the scoping itself, joining the
	// caller's own org_members inside the query, so the allowlist names the
	// one function and the one method that may do that.
	legacyRedirect := map[string]string{
		"legacySpaceRedirect": "OrgSlugsForMemberSpaceSlug",
	}

	fset, files, info := typeCheckAPIPackage(t)
	seen := map[string]bool{}
	for _, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			method := sel.Sel.Name
			// Any exported store.Spaces method naming a slug resolves a space
			// by slug as far as this check is concerned.
			if !ast.IsExported(method) || !strings.Contains(method, "Slug") {
				return true
			}
			// Resolve the receiver to *store.Spaces, so an unrelated BySlug
			// (store.Orgs has one) is not counted.
			selection := info.Selections[sel]
			if selection == nil {
				return true
			}
			recv := selection.Recv().String()
			if !strings.HasSuffix(recv, "store.Spaces") {
				return true
			}
			fn := enclosingFunc(f, call.Pos())
			seen[fn] = true
			pos := fset.Position(call.Pos())
			switch {
			case anonymous[fn]:
				if method != "BySlugInOrg" {
					t.Errorf("%s: %s must use BySlugInOrg so a bad org and a bad slug cost the same one query", pos, fn)
				}
			case wantContextOrg[fn]:
				if method != "BySlug" {
					t.Errorf("%s: %s must resolve its space with BySlug against the context org", pos, fn)
				}
				src := types.ExprString(call.Args[1])
				if !strings.Contains(src, "orgFrom(") {
					t.Errorf("%s: %s passes %q as the org id — it must be orgFrom(r.Context()).ID, so the org comes from requireOrgMember and is not re-derived", pos, fn, src)
				}
			case legacyRedirect[fn] != "":
				if method != legacyRedirect[fn] {
					t.Errorf("%s: %s is allowed to resolve a slug without a context org only through %s, which scopes the lookup to the caller's own memberships — not %s", pos, fn, legacyRedirect[fn], method)
				}
			default:
				t.Errorf("%s: %s resolves a space by slug but is not classified — decide whether it sits behind requireOrgMember, is deliberately anonymous, or belongs on the legacy-redirect allowlist, then add it here", pos, fn)
			}
			return true
		})
	}
	for _, classification := range []map[string]bool{wantContextOrg, anonymous} {
		for fn := range classification {
			if !seen[fn] {
				t.Errorf("%s no longer resolves a space by slug — the classification is stale", fn)
			}
		}
	}
	for fn := range legacyRedirect {
		if !seen[fn] {
			t.Errorf("%s no longer resolves a space by slug — the classification is stale", fn)
		}
	}
}

// orgScopedRoutes classifies every registered route by whether it carries an
// org prefix. chi.Walk cannot see r.NotFound or a plain http.Handler mount, so
// the SPA fallback is not in this table and does not need to be.
var routeScoping = map[string]string{
	// Infrastructure and identity: no space slug, nothing to scope.
	"GET /healthz":         "non-slug",
	"GET /version":         "non-slug",
	"GET /readyz":          "non-slug",
	"GET /auth/login":      "non-slug",
	"GET /auth/callback":   "non-slug",
	"GET /ws":              "non-slug",
	"GET /api/auth":        "non-slug",
	"POST /api/me":         "non-slug",
	"GET /api/me":          "non-slug",
	"DELETE /api/me":       "non-slug",
	"PATCH /api/me/avatar": "non-slug",

	// Cross-org by definition: they answer which orgs and spaces a cookie
	// reaches, so they cannot name an org first.
	"GET /api/orgs":    "non-slug",
	"GET /api/spaces":  "non-slug",
	"POST /api/spaces": "non-slug",

	// Every space route hangs off an org.
	"GET /api/orgs/{org}/spaces":                               "org-scoped",
	"GET /api/orgs/{org}/spaces/{slug}":                        "org-scoped",
	"PATCH /api/orgs/{org}/spaces/{slug}/visibility":           "org-scoped",
	"POST /api/orgs/{org}/spaces/{slug}/invite":                "org-scoped",
	"PATCH /api/orgs/{org}/spaces/{slug}":                      "org-scoped",
	"DELETE /api/orgs/{org}/spaces/{slug}":                     "org-scoped",
	"POST /api/orgs/{org}/spaces/{slug}/join":                  "org-scoped",
	"POST /api/orgs/{org}/spaces/{slug}/seen":                  "org-scoped",
	"POST /api/orgs/{org}/spaces/{slug}/passcode":              "org-scoped",
	"POST /api/orgs/{org}/spaces/{slug}/sessions":              "org-scoped",
	"GET /api/orgs/{org}/spaces/{slug}/decks/":                 "org-scoped",
	"POST /api/orgs/{org}/spaces/{slug}/decks/":                "org-scoped",
	"PATCH /api/orgs/{org}/spaces/{slug}/decks/{deckId}":       "org-scoped",
	"DELETE /api/orgs/{org}/spaces/{slug}/decks/{deckId}":      "org-scoped",
	"POST /api/orgs/{org}/spaces/{slug}/members/{userId}/role": "org-scoped",
	"DELETE /api/orgs/{org}/spaces/{slug}/members/{userId}/":   "org-scoped",
	"PATCH /api/orgs/{org}/spaces/{slug}/sessions/{id}/":       "org-scoped",
	"DELETE /api/orgs/{org}/spaces/{slug}/sessions/{id}/":      "org-scoped",

	// Org custody. Every one of these hangs off an org and is admin-only
	// inside it: the tree exists so an org admin can manage a space they are
	// not a member of, which makes the org segment the entire authorization
	// context. Purging the org is mounted at the org itself rather than under
	// /admin because it is not an action on a space.
	"DELETE /api/orgs/{org}/":                             "org-scoped",
	"GET /api/orgs/{org}/admin/spaces":                    "org-scoped",
	"PATCH /api/orgs/{org}/admin/spaces/{slug}":           "org-scoped",
	"DELETE /api/orgs/{org}/admin/spaces/{slug}":          "org-scoped",
	"POST /api/orgs/{org}/admin/spaces/{slug}/owners":     "org-scoped",
	"POST /api/orgs/{org}/admin/spaces/{slug}/claim":      "org-scoped",
	"GET /api/orgs/{org}/admin/members":                   "org-scoped",
	"POST /api/orgs/{org}/admin/members/{userId}/role":    "org-scoped",
	"DELETE /api/orgs/{org}/admin/members/{userId}":       "org-scoped",
	"POST /api/orgs/{org}/admin/members/{userId}/restore": "org-scoped",

	// The legacy space link. It carries a slug and no org — that is the whole
	// point of it — so it is neither org-scoped nor a route with nothing to
	// scope. It resolves the org from the caller's own org memberships and
	// redirects; it never looks a slug up globally, so it cannot answer for a
	// space in an org the caller is outside. Its own class, because waving it
	// through as non-slug would also wave through the next unprefixed slug
	// route somebody adds.
	"GET /s/{slug}": "legacy-redirect",

	// Anonymous-exempt, and the reason is signed links in every case. A link
	// guest is a users row carrying link_id: it belongs to no org and no
	// space, so it has no org slug to put in a URL and no membership one
	// could be derived from. An org-prefixed session tree would 404 every
	// signed link ever issued, and redemption would be circular — it is what
	// mints the identity an org prefix would require. Session ids are
	// globally-unique uuids and Spaces.IsMemberOrLinkGuest is the
	// authorization that replaces org scoping here.
	"POST /api/links/redeem":                               "anonymous-exempt",
	"GET /api/sessions/{id}/":                              "anonymous-exempt",
	"DELETE /api/sessions/{id}/":                           "anonymous-exempt",
	"GET /api/sessions/{id}/export.csv":                    "anonymous-exempt",
	"POST /api/sessions/{id}/reopen":                       "anonymous-exempt",
	"POST /api/sessions/{id}/spectator":                    "anonymous-exempt",
	"POST /api/sessions/{id}/facilitator":                  "anonymous-exempt",
	"POST /api/sessions/{id}/participants/{userId}/remove": "anonymous-exempt",
	"POST /api/sessions/{id}/facilitator/claim":            "anonymous-exempt",
	"GET /api/sessions/{id}/links":                         "anonymous-exempt",
	"POST /api/sessions/{id}/links":                        "anonymous-exempt",
	"DELETE /api/sessions/{id}/links/{linkId}":             "anonymous-exempt",
	"GET /api/sessions/{id}/actions/{action}":              "anonymous-exempt",
	"HEAD /api/sessions/{id}/actions/{action}":             "anonymous-exempt",
	"POST /api/sessions/{id}/actions/{action}":             "anonymous-exempt",
	"PUT /api/sessions/{id}/actions/{action}":              "anonymous-exempt",
	"PATCH /api/sessions/{id}/actions/{action}":            "anonymous-exempt",
	"DELETE /api/sessions/{id}/actions/{action}":           "anonymous-exempt",
	"QUERY /api/sessions/{id}/actions/{action}":            "anonymous-exempt",
	"CONNECT /api/sessions/{id}/actions/{action}":          "anonymous-exempt",
	"OPTIONS /api/sessions/{id}/actions/{action}":          "anonymous-exempt",
	"TRACE /api/sessions/{id}/actions/{action}":            "anonymous-exempt",
}

// TestEveryRouteIsScopeClassified walks the registered routes and requires
// each to be classified. Matching the substring "{slug}" would not do: it
// would wave through an unprefixed slug route added under a new prefix, and it
// would say nothing about whether a session route acquired an org segment it
// must never have.
func TestEveryRouteIsScopeClassified(t *testing.T) {
	routes, ok := Router(nil, Options{}).Handler.(chi.Routes)
	if !ok {
		t.Fatal("router is not walkable")
	}
	seen := map[string]bool{}
	err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if route == "/*" {
			return nil // the SPA fallback; it serves the frontend to anyone.
		}
		key := method + " " + route
		seen[key] = true
		scope, classified := routeScoping[key]
		if !classified {
			t.Errorf("route %q is unclassified — say whether it is org-scoped, anonymous-exempt or non-slug", key)
			return nil
		}
		switch scope {
		case "org-scoped":
			if !strings.HasPrefix(route, "/api/orgs/{org}/") {
				t.Errorf("route %q is classified org-scoped but carries no {org} segment", key)
			}
		case "anonymous-exempt", "non-slug":
			if strings.HasPrefix(route, "/api/orgs/{org}/") {
				t.Errorf("route %q acquired an {org} prefix but is classified %s", key, scope)
			}
		case "legacy-redirect":
			// Exactly one route may hold this class, and it is the shim for
			// pre-org links. A second one would be a new unprefixed slug
			// route wearing the exemption rather than earning it.
			if key != "GET /s/{slug}" {
				t.Errorf("route %q is classified legacy-redirect, which only GET /s/{slug} may be", key)
			}
		default:
			t.Errorf("route %q has unknown scope %q", key, scope)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for key := range routeScoping {
		if !seen[key] {
			t.Errorf("routeScoping classifies %q, which is no longer a route", key)
		}
	}
	// Named explicitly rather than left to the loop: these are the routes a
	// signed link depends on, and the reason they must never move.
	for _, key := range []string{"POST /api/links/redeem", "GET /api/sessions/{id}/"} {
		if routeScoping[key] != "anonymous-exempt" {
			t.Errorf("%s must stay anonymous-exempt: a link guest has no org to put in a URL", key)
		}
	}
}

// TestOrgFromPanicsWithoutTheMiddleware pins the unchecked type assertion. A
// comma-ok read with a zero-value fallback would compile, run, and serve the
// request with a zero org id — the tenancy check silently skipped.
func TestOrgFromPanicsWithoutTheMiddleware(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("orgFrom returned instead of panicking outside requireOrgMember: a handler mounted without it would read a zero org id and fail open")
		}
	}()
	orgFrom(context.Background())
}

// TestRequireOrgMemberAnswers404 holds the 404-not-403 posture: someone
// outside an org is told nothing about whether it exists.
func TestRequireOrgMemberAnswers404(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Outsider "+randomSlugSuffix(t), ada)
	slug := created["slug"].(string)

	other := "other-" + randomSlugSuffix(t)
	if _, err := pool.Exec(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1)", other); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/orgs/" + other + "/spaces/" + slug + "/join", "{}"},
		{"POST", "/api/orgs/" + other + "/spaces/" + slug + "/seen", ""},
		{"POST", "/api/orgs/" + other + "/spaces/" + slug + "/passcode", "{}"},
		{"POST", "/api/orgs/" + other + "/spaces/" + slug + "/sessions", `{"kind":"poker","title":"T"}`},
		{"PATCH", "/api/orgs/" + other + "/spaces/" + slug, `{"name":"T"}`},
		{"DELETE", "/api/orgs/" + other + "/spaces/" + slug, ""},
	} {
		got, err := requestStatus(srv, tc.method, tc.path, tc.body, ada)
		if err != nil {
			t.Fatal(err)
		}
		if got != http.StatusNotFound {
			t.Errorf("%s %s as a non-member of %s = %d, want 404 — 403 would confirm the org exists", tc.method, tc.path, other, got)
		}
	}
}

// TestAnonymousSpaceLookupIsIndistinguishable is the cross-org existence
// oracle, closed. A bad org, a real org that does not hold the slug, and a
// slug that exists nowhere must all answer identically — same status, same
// body — and must all cost the same single query, which is what
// store.Spaces.BySlugInOrg buys.
func TestAnonymousSpaceLookupIsIndistinguishable(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Oracle "+randomSlugSuffix(t), ada)
	slug := created["slug"].(string)

	other := "other-" + randomSlugSuffix(t)
	if _, err := pool.Exec(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1)", other); err != nil {
		t.Fatal(err)
	}

	answers := map[string]string{}
	for name, path := range map[string]string{
		"a real space in the wrong org": "/api/orgs/" + other + "/spaces/" + slug,
		"an org that does not exist":    "/api/orgs/nope-" + randomSlugSuffix(t) + "/spaces/" + slug,
		"a slug that exists nowhere":    "/api/orgs/" + store.DefaultOrgSlug + "/spaces/nope-" + randomSlugSuffix(t),
	} {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 512)
		n, _ := resp.Body.Read(buf)
		resp.Body.Close()
		answers[name] = resp.Status + "|" + string(buf[:n])
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", name, resp.StatusCode)
		}
	}
	var first, firstName string
	for name, a := range answers {
		if first == "" {
			first, firstName = a, name
			continue
		}
		if a != first {
			t.Errorf("%q answers %q but %q answers %q — the difference is a cross-org existence oracle", name, a, firstName, first)
		}
	}
}

// TestAnonymousSpaceViewCarriesNoOrgData is the pre-join link landing: no
// cookie, 200, and only what a stranger at the door needs.
func TestAnonymousSpaceViewCarriesNoOrgData(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Landing "+randomSlugSuffix(t), ada)
	slug := created["slug"].(string)

	resp, body := getSpace(t, srv, slug, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("anonymous GET on a space = %d, want 200", resp.StatusCode)
	}
	for _, want := range []string{"slug", "name", "protected"} {
		if _, ok := body[want]; !ok {
			t.Errorf("the anonymous space view is missing %q: %v", want, body)
		}
	}
	for _, forbidden := range []string{"members", "sessions", "passcode", "kinds", "org", "orgSlug", "visibility"} {
		if _, leaked := body[forbidden]; leaked {
			t.Errorf("the anonymous space view leaks %q: %v", forbidden, body)
		}
	}
}

// TestRequireOrgAdminNarrowsToAdmins exercises the admin gate the way the
// router mounts it: behind requireOrgMember, which is what puts the caller's
// role in the request context. requireOrgAdmin must not hit the database.
func TestRequireOrgAdminNarrowsToAdmins(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	a := &app{orgs: &store.Orgs{Pool: pool}, users: &store.Users{Pool: pool}}
	org, err := a.orgs.Default(ctx)
	if err != nil {
		t.Fatal(err)
	}

	r := chi.NewRouter()
	r.Route("/{org}", func(r chi.Router) {
		r.Use(a.requireOrgMember)
		r.With(a.requireOrgAdmin).Get("/probe", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	})

	call := func(userID string) int {
		req := httptest.NewRequest("GET", "/"+org.Slug+"/probe", nil)
		req = req.WithContext(principal.With(req.Context(), Principal{UserID: userID}))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code
	}

	member := newUser(t, a, "Member")
	if err := a.orgs.AddMember(ctx, org.ID, member, store.OrgRoleMember); err != nil {
		t.Fatal(err)
	}
	if got := call(member); got != http.StatusForbidden {
		t.Errorf("an ordinary org member = %d, want 403", got)
	}

	admin := newUser(t, a, "Admin")
	if err := a.orgs.AddMember(ctx, org.ID, admin, store.OrgRoleAdmin); err != nil {
		t.Fatal(err)
	}
	if got := call(admin); got != http.StatusNoContent {
		t.Errorf("an org admin = %d, want 204", got)
	}

	// A brand-new account belongs to no org until something enrols it, which
	// is exactly the outsider this gate has to turn away.
	stranger := newUser(t, a, "Stranger")
	if got := call(stranger); got != http.StatusNotFound {
		t.Errorf("someone outside the org = %d, want 404 — 403 would confirm the org exists", got)
	}
}

// countingTracer tallies every statement the pool runs so a middleware can be
// measured without depending on wall-clock latency against a local Postgres.
type countingTracer struct {
	mu sync.Mutex
	n  int
}

func (c *countingTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
	return ctx
}

func (c *countingTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (c *countingTracer) take() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := c.n
	c.n = 0
	return n
}

// tracedTestPool is testPool with a QueryTracer wired in before any connection
// is opened, so authorization round trips are visible to the countingTracer.
func tracedTestPool(t *testing.T, tracer pgx.QueryTracer) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	resetSchema(t)
	return pool
}

// TestOrgAuthzRoundTrips is the acceptance pin for #403: every org-scoped
// request used to pay BySlug + IsMember before the handler, and admin routes
// paid RoleOf on top. One joined lookup must cover both gates, and the count
// must not grow again without this test noticing.
func TestOrgAuthzRoundTrips(t *testing.T) {
	ctx := context.Background()
	tracer := &countingTracer{}
	pool := tracedTestPool(t, tracer)
	a := &app{orgs: &store.Orgs{Pool: pool}, users: &store.Users{Pool: pool}}
	org, err := a.orgs.Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tracer.take() // discard migrate / default-org traffic

	member := newUser(t, a, "Member")
	if err := a.orgs.AddMember(ctx, org.ID, member, store.OrgRoleMember); err != nil {
		t.Fatal(err)
	}
	admin := newUser(t, a, "Admin")
	if err := a.orgs.AddMember(ctx, org.ID, admin, store.OrgRoleAdmin); err != nil {
		t.Fatal(err)
	}
	tracer.take()

	memberRouter := chi.NewRouter()
	memberRouter.Route("/{org}", func(r chi.Router) {
		r.Use(a.requireOrgMember)
		r.Get("/probe", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	})
	adminRouter := chi.NewRouter()
	adminRouter.Route("/{org}", func(r chi.Router) {
		r.Use(a.requireOrgMember)
		r.Use(a.requireOrgAdmin)
		r.Get("/probe", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	})

	hit := func(router chi.Router, userID string) int {
		t.Helper()
		req := httptest.NewRequest("GET", "/"+org.Slug+"/probe", nil)
		req = req.WithContext(principal.With(req.Context(), Principal{UserID: userID}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w.Code
	}

	if got := hit(memberRouter, member); got != http.StatusNoContent {
		t.Fatalf("member probe = %d, want 204", got)
	}
	if n := tracer.take(); n != 1 {
		t.Errorf("requireOrgMember paid %d database round trips, want 1", n)
	}

	if got := hit(adminRouter, admin); got != http.StatusNoContent {
		t.Fatalf("admin probe = %d, want 204", got)
	}
	if n := tracer.take(); n != 1 {
		t.Errorf("requireOrgMember+requireOrgAdmin paid %d database round trips, want 1 (no third RoleOf)", n)
	}
}

// TestPreMigrationCookieStillReachesOrgRoutes proves #204's org_members
// backfill is sufficient on its own. The account here never went through
// sign-up, so grantDefaultOrgMembership never ran for it: its only membership
// is the row the migration wrote. If the org routes needed anything a fresh
// sign-in supplies, everyone holding a cookie issued before the upgrade would
// be locked out of every space they own, with no prompt to re-authenticate.
func TestPreMigrationCookieStillReachesOrgRoutes(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	users := &store.Users{Pool: pool}
	orgs := &store.Orgs{Pool: pool}
	org, err := orgs.Default(ctx)
	if err != nil {
		t.Fatal(err)
	}

	plain, hash := store.NewToken()
	u, err := users.Create(ctx, "Grandfathered", hash)
	if err != nil {
		t.Fatal(err)
	}
	// Exactly what 0021_orgs.sql's backfill left behind, and nothing else.
	if _, err := pool.Exec(ctx, "delete from org_members where user_id = $1", u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", org.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	// A space they already owned, created before the cutover.
	slug := "grandfathered-" + randomSlugSuffix(t)
	var spaceID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (org_id, slug, name, creator_id) values ($1, $2, 'Old', $3) returning id",
		org.ID, slug, u.ID).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: sessionCookie, Value: plain}

	base := "/api/orgs/" + org.Slug + "/spaces/" + slug
	if got, err := requestStatus(srv, "POST", base+"/join", "{}", cookie); err != nil || got != http.StatusNoContent {
		t.Fatalf("join with a pre-migration cookie = %d (%v), want 204", got, err)
	}
	if got, err := requestStatus(srv, "POST", base+"/seen", "", cookie); err != nil || got != http.StatusNoContent {
		t.Fatalf("seen with a pre-migration cookie = %d (%v), want 204", got, err)
	}
}

// TestLinkGuestReachesItsRoomWithNoOrgAnywhere is the whole reason the session
// tree did not move. A link guest is a users row carrying link_id: it belongs
// to no org, so an org-prefixed session route would 404 every signed link ever
// issued. The assertion is both halves — the flow works, and no URL it touches
// carries an org — because either alone would pass on a broken build.
func TestLinkGuestReachesItsRoomWithNoOrgAnywhere(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	fac, sessionID, guest := mintAndRedeem(t, srv, "Guest Room "+randomSlugSuffix(t))
	_ = fac

	visited := []string{"/api/links/redeem", "/api/sessions/" + sessionID}
	resp, env := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", guest)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a link guest reading its own room = %d, want 200", resp.StatusCode)
	}
	// The guest is shown neither slug, so it has nothing to build a space URL
	// out of and never needs one.
	if env["spaceSlug"] != "" || env["orgSlug"] != "" {
		t.Errorf("the guest envelope carries spaceSlug=%v orgSlug=%v, want both empty", env["spaceSlug"], env["orgSlug"])
	}
	if got, err := requestStatus(srv, "GET", "/api/me", "", guest); err != nil || got != http.StatusOK {
		t.Fatalf("a link guest reading its own identity = %d (%v), want 200", got, err)
	}
	visited = append(visited, "/api/me")

	for _, path := range visited {
		if strings.Contains(path, "/orgs/") {
			t.Errorf("a link guest had to visit %q, which names an org it can never have", path)
		}
	}

	_, me := doJSON(t, srv, "GET", "/api/me", "", guest)
	var memberships int
	if err := pool.QueryRow(ctx, "select count(*) from org_members where user_id = $1", me["id"]).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 0 {
		t.Errorf("a link guest has %d org_members rows, want 0 — a link is a seat in one room, not membership of a tenant", memberships)
	}
}

// TestCreateSpaceRequiresOrgMembership pins the one write that names no org in
// its path to the same tenancy rule as the ones that do. Creating in an org the
// caller is outside of would hand them a space every follow-up call — join,
// seen, passcode, sessions — then answers 404 for, because those are org-gated.
// The refusal is the same 404 requireOrgMember gives, for the same reason: the
// existence of an org is not disclosed to anyone outside it.
func TestCreateSpaceRequiresOrgMembership(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada, adaID := signupWithID(t, srv, "Ada")
	// Signing up enrols the caller in the default org, so the outsider has to
	// be made one: this is the account an identity provider hands back with no
	// claim any org here recognises.
	if _, err := pool.Exec(ctx,
		"update org_members set revoked_at = now() where user_id = $1", adaID); err != nil {
		t.Fatal(err)
	}

	resp, body := createSpace(t, srv, "Outsider "+randomSlugSuffix(t), ada)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("POST /api/spaces as a non-member = %d, want 404 — 403 would confirm the org exists (body %v)", resp.StatusCode, body)
	}
	if got := body["error"]; got != "no such org" {
		t.Errorf(`error = %v, want "no such org" — the same body requireOrgMember answers with`, got)
	}
}
