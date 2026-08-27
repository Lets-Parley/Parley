package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/auth"
	"github.com/lets-parley/parley/internal/store"
)

// oidcServerMapping wires a Parley router in OIDC mode with org mapping
// configured, and hands back the pool so the rows the sign-in wrote can be
// read back.
func oidcServerMapping(t *testing.T, idp *fakeIdP, orgClaim string, admin BootstrapAdmin) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	return testServerWith(t, pool, Options{
		AllowedOrigin:  "http://example.test",
		AuthMode:       ModeOIDC,
		BootstrapAdmin: admin,
		OIDC: auth.New(auth.Config{
			Issuer:      idp.URL,
			ClientID:    "parley-test",
			RedirectURL: "http://example.test/auth/callback",
			OrgClaim:    orgClaim,
		}),
	}), pool
}

// signIn walks the whole sign-in and returns the session cookie it issued.
func signIn(t *testing.T, srv *httptest.Server, idp *fakeIdP) *http.Cookie {
	t.Helper()
	authURL, flow := startSignin(t, srv, "/")
	idp.nonce = authURL.Query().Get("nonce")
	resp := callback(t, srv, flow, authURL.Query().Get("state"))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("callback status = %d, want 302", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			return c
		}
	}
	t.Fatal("sign-in issued no session cookie")
	return nil
}

// memberships maps org id to role for one user, reading revoked rows as
// absent — the same rule IsMember applies.
func memberships(t *testing.T, pool *pgxpool.Pool, userID string) map[string]string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		"select org_id, role from org_members where user_id = $1 and revoked_at is null", userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]string{}
	for rows.Next() {
		var org, role string
		if err := rows.Scan(&org, &role); err != nil {
			t.Fatal(err)
		}
		got[org] = role
	}
	return got
}

func userIDOf(t *testing.T, srv *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	_, me := getMe(t, srv, cookie)
	id, _ := me["id"].(string)
	if id == "" {
		t.Fatalf("no user id in /api/me: %v", me)
	}
	return id
}

// newOrg registers an org with its own claim value and returns its id.
func newOrg(t *testing.T, pool *pgxpool.Pool, claim string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		"insert into orgs (slug, name, claim_value) values ($1, 'Mapped', $2) returning id", claim, claim,
	).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestSignInMapsMappedClaimsOnly is the whole of phase 2: the identity
// provider says which groups someone is in, and Parley translates only the
// ones an admin already registered on an org. An unrecognised value grants
// nothing and creates nothing.
func TestSignInMapsMappedClaimsOnly(t *testing.T) {
	idp := newFakeIdP(t)
	suffix := randomSlugSuffix(t)
	idp.subject = "mapped-" + suffix
	srv, pool := oidcServerMapping(t, idp, "", BootstrapAdmin{})
	orgID := newOrg(t, pool, "platform-"+suffix)
	idp.extra = map[string]any{"groups": []any{"platform-" + suffix, "not-an-org-" + suffix}}

	userID := userIDOf(t, srv, signIn(t, srv, idp))
	got := memberships(t, pool, userID)
	if got[orgID] != store.OrgRoleMember {
		t.Errorf("membership of the mapped org = %q, want %q", got[orgID], store.OrgRoleMember)
	}
	if len(got) != 1 {
		t.Errorf("memberships = %v, want only the mapped org", got)
	}

	// A token carrying only unmapped values maps to nothing at all.
	idp.subject = "unmapped-" + suffix
	idp.extra = map[string]any{"groups": []any{"not-an-org-" + suffix}}
	other := userIDOf(t, srv, signIn(t, srv, idp))
	if got := memberships(t, pool, other); len(got) != 0 {
		t.Errorf("an unmapped claim granted %v, want nothing", got)
	}
	var orgs int
	if err := pool.QueryRow(context.Background(),
		"select count(*) from orgs where claim_value = $1", "not-an-org-"+suffix).Scan(&orgs); err != nil {
		t.Fatal(err)
	}
	if orgs != 0 {
		t.Error("an unrecognised claim value created an org")
	}
}

// TestSignInHonoursRevocation: the claim arrives again on every sign-in, so
// without the tombstone rule an admin's removal would last until the revoked
// person next logged in.
func TestSignInHonoursRevocation(t *testing.T) {
	ctx := context.Background()
	idp := newFakeIdP(t)
	suffix := randomSlugSuffix(t)
	idp.subject = "revoked-" + suffix
	srv, pool := oidcServerMapping(t, idp, "", BootstrapAdmin{})
	orgID := newOrg(t, pool, "platform-"+suffix)
	idp.extra = map[string]any{"groups": "platform-" + suffix}

	userID := userIDOf(t, srv, signIn(t, srv, idp))
	if _, err := pool.Exec(ctx,
		"update org_members set revoked_at = now() where org_id = $1 and user_id = $2", orgID, userID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		signIn(t, srv, idp)
		if got := memberships(t, pool, userID); len(got) != 0 {
			t.Fatalf("signing in again restored a revoked membership: %v", got)
		}
	}
}

// TestBootstrapAdminIsGrantedFromConfig: without this a fresh OIDC instance is
// unusable — no org matches any claim, so nobody is an admin and nobody can
// create the first org. The pair is the identity, because the users row does
// not exist until the admin first signs in.
func TestBootstrapAdminIsGrantedFromConfig(t *testing.T) {
	idp := newFakeIdP(t)
	suffix := randomSlugSuffix(t)
	idp.subject = "boss-" + suffix
	srv, pool := oidcServerMapping(t, idp, "", BootstrapAdmin{Issuer: idp.URL, Subject: "boss-" + suffix})
	defaultOrg, err := (&store.Orgs{Pool: pool}).Default(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	admin := userIDOf(t, srv, signIn(t, srv, idp))
	if got := memberships(t, pool, admin); got[defaultOrg.ID] != store.OrgRoleAdmin {
		t.Errorf("bootstrap admin's role = %q, want %q", got[defaultOrg.ID], store.OrgRoleAdmin)
	}

	// The subject alone is not the identity: the same subject from another
	// issuer is a different person, and so is another subject.
	idp.subject = "someone-else-" + suffix
	other := userIDOf(t, srv, signIn(t, srv, idp))
	if got := memberships(t, pool, other); len(got) != 0 {
		t.Errorf("a non-bootstrap subject was granted %v, want nothing", got)
	}
}

// TestOpenModeEnrolsAccountsAsPlainMembers: orgs ship to every deployment, so
// open mode needs a coherent story — one org, everybody in it, nobody an admin.
func TestOpenModeEnrolsAccountsAsPlainMembers(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	defaultOrg, err := (&store.Orgs{Pool: pool}).Default(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	cookie, userID := signupWithID(t, srv, "Ada")
	got := memberships(t, pool, userID)
	if got[defaultOrg.ID] != store.OrgRoleMember {
		t.Errorf("open-mode membership = %q, want %q in the default org", got[defaultOrg.ID], store.OrgRoleMember)
	}
	if len(got) != 1 {
		t.Errorf("memberships = %v, want only the default org", got)
	}
	// Renaming rotates the token and must not change any of that.
	postMe(t, srv, "Ada Lovelace", cookie)
	if got := memberships(t, pool, userID); got[defaultOrg.ID] != store.OrgRoleMember || len(got) != 1 {
		t.Errorf("memberships after a rename = %v, want just member of the default org", got)
	}
}

// TestLinkGuestGainsNoOrgMembership is the trap this phase most has to avoid.
// A redeemed link mints an ordinary users row, so "every user joins the
// default org" silently includes link guests — and that hands anyone holding
// one link directory visibility over the whole instance. Asserted after
// redeeming a real link rather than against a hand-built principal, because a
// hand-built one cannot prove the redemption path stayed clear.
func TestLinkGuestGainsNoOrgMembership(t *testing.T) {
	for _, mode := range []string{ModeOpen, ModeOIDC} {
		t.Run(mode, func(t *testing.T) {
			pool := testPool(t)
			opts := Options{AllowedOrigin: testOrigin, AuthMode: mode}
			if mode == ModeOIDC {
				idp := newFakeIdP(t)
				opts.OIDC = auth.New(auth.Config{Issuer: idp.URL, ClientID: "parley-test"})
			}
			srv := testServerWith(t, pool, opts)
			// The room is set up in open mode: OIDC refuses /api/me, and what
			// is under test is redemption, not how the room was made.
			host := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
			fac, _, sessionID := setupSession(t, host, "Guest Org "+randomSlugSuffix(t))
			_, minted := mintLink(t, host, sessionID, fac)
			token, _ := minted["token"].(string)
			if token == "" {
				t.Fatalf("mint returned no token: %v", minted)
			}

			resp, body, guest := redeem(t, srv, token, "Gus")
			if resp.StatusCode != http.StatusCreated {
				t.Fatalf("redeem: got %d, want 201 (%v)", resp.StatusCode, body)
			}
			guestID := userIDOf(t, srv, guest)
			if got := memberships(t, pool, guestID); len(got) != 0 {
				t.Fatalf("a link guest was enrolled in %v — a capability on one room became a tenancy", got)
			}
			var rows int
			if err := pool.QueryRow(context.Background(),
				"select count(*) from org_members where user_id = $1", guestID).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if rows != 0 {
				t.Errorf("a link guest has %d org_members rows, want none even revoked", rows)
			}
		})
	}
}
