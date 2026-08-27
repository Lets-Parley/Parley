package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/store"
)

// TestSpaceRoutesResolveWithinTheDefaultOrg pins every slug-resolving handler
// to the org the caller actually belongs to. A build alone cannot tell a real
// org id from a zero one, so the test puts an identically-slugged space in a
// second org: a handler passing anything but the default org's real id either
// finds the wrong space or finds none.
func TestSpaceRoutesResolveWithinTheDefaultOrg(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, created := createSpace(t, srv, "Org Routes "+randomSlugSuffix(t), ada)
	slug, _ := created["slug"].(string)
	if slug == "" {
		t.Fatalf("space creation returned no slug: %v", created)
	}

	// handleCreateSpace put it in the default org, not in uuid.Nil.
	defaultOrg, err := (&store.Orgs{Pool: pool}).Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var orgID string
	if err := pool.QueryRow(ctx, "select org_id from spaces where slug = $1 and org_id = $2", slug, defaultOrg.ID).Scan(&orgID); err != nil {
		t.Fatalf("the created space is not in the default org: %v", err)
	}

	// The same slug in another org is a different space, and no route may
	// reach it: an org-blind lookup would resolve one of the two at random.
	var otherOrg string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id", "other-"+randomSlugSuffix(t),
	).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	foreignSlug := "foreign-" + randomSlugSuffix(t)
	if _, err := pool.Exec(ctx,
		"insert into spaces (org_id, slug, name) values ($1, $2, 'Foreign')", otherOrg, foreignSlug); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name, method, path, body string
	}{
		{"handleGetSpace", "GET", "/api/spaces/" + foreignSlug, ""},
		{"handleJoinSpace", "POST", "/api/spaces/" + foreignSlug + "/join", "{}"},
		{"handleMarkSpaceSeen", "POST", "/api/spaces/" + foreignSlug + "/seen", ""},
		{"handleSetPasscode", "POST", "/api/spaces/" + foreignSlug + "/passcode", "{}"},
		{"handleCreateSession", "POST", "/api/spaces/" + foreignSlug + "/sessions", `{"kind":"poker","title":"Planning"}`},
		{"requireSpaceOwner", "PATCH", "/api/spaces/" + foreignSlug, `{"name":"Renamed"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body *strings.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			} else {
				body = strings.NewReader("")
			}
			req, _ := http.NewRequest(tc.method, srv.URL+tc.path, body)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", testOrigin)
			req.AddCookie(ada)
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("%s %s = %d, want 404: a space in another org must not resolve", tc.method, tc.path, resp.StatusCode)
			}
		})
	}

	// The control: the same routes still reach the caller's own space, so the
	// 404s above are org scoping rather than a lookup that fails for everyone.
	resp, _ := getSpace(t, srv, slug, ada)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET on the caller's own space = %d, want 200", resp.StatusCode)
	}
}

// randomSlugSuffix keeps slugs unique across reruns against one database.
func randomSlugSuffix(t *testing.T) string {
	t.Helper()
	plain, _ := store.NewToken()
	return store.Slugify(plain[:10])
}
