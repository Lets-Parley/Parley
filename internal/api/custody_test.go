package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// custodyPath is the custody tree's prefix for the default org.
const custodyPath = "/api/orgs/" + store.DefaultOrgSlug + "/admin"

// makeOrgAdmin promotes an account to admin of the default org. Signing up
// enrols the caller as an ordinary member, and nothing in the API promotes
// anyone yet — the bootstrap-admin path is configuration, not a route — so the
// row is written directly.
func makeOrgAdmin(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"update org_members set role = 'admin', revoked_at = null where user_id = $1", userID); err != nil {
		t.Fatal(err)
	}
}

// custodyServer is a server plus an org admin who is deliberately a member of
// no space in it: every custody test starts from the outsider the phase exists
// to constrain.
func custodyServer(t *testing.T) (*httptest.Server, *pgxpool.Pool, *http.Cookie, string) {
	t.Helper()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	admin, adminID := signupWithID(t, srv, "Admin")
	makeOrgAdmin(t, pool, adminID)
	return srv, pool, admin, adminID
}

// custodyList reads the custody tree and hands back the raw JSON objects, so a
// test can assert on the keys a handler actually wrote rather than on the
// struct it was supposed to write.
func custodyList(t *testing.T, srv *httptest.Server, cookie *http.Cookie) (*http.Response, []map[string]json.RawMessage) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+custodyPath+"/spaces", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var spaces []map[string]json.RawMessage
	json.NewDecoder(resp.Body).Decode(&spaces)
	return resp, spaces
}

func custodyDo(t *testing.T, srv *httptest.Server, method, path, body string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	return doJSON(t, srv, method, custodyPath+path, body, cookie)
}

// privateSpace creates a space owned by somebody other than the admin: the
// outsider's-eye view every custody test starts from. The passcode comes back
// too, so a test that needs a second real member can put one there without
// reaching into the database.
func privateSpace(t *testing.T, srv *httptest.Server) (slug string, owner *http.Cookie, ownerID, passcode string) {
	t.Helper()
	owner, ownerID = signupWithID(t, srv, "Owner")
	resp, created := createSpace(t, srv, "Private "+randomSlugSuffix(t), owner)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d: %v", resp.StatusCode, created)
	}
	passcode, _ = created["passcode"].(string)
	return created["slug"].(string), owner, ownerID, passcode
}

// joinSpace puts an ordinary org member inside a space through the front door.
func custodyJoin(t *testing.T, srv *httptest.Server, slug, passcode string, cookie *http.Cookie) {
	t.Helper()
	got, err := requestStatus(srv, "POST",
		"/api/orgs/"+store.DefaultOrgSlug+"/spaces/"+slug+"/join", `{"passcode":"`+passcode+`"}`, cookie)
	if err != nil || got != http.StatusNoContent {
		t.Fatalf("join = %d (%v), want 204", got, err)
	}
}

// TestCustodySpaceCarriesOnlyTheAllowList unmarshals into raw JSON rather than
// into CustodySpace: decoding into the struct would silently drop any extra
// key a handler marshalling an untyped map had added, which is the exact
// mistake this is here to catch.
func TestCustodySpaceCarriesOnlyTheAllowList(t *testing.T) {
	srv, _, admin, _ := custodyServer(t)
	privateSpace(t, srv)

	resp, spaces := custodyList(t, srv, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("custody list = %d, want 200", resp.StatusCode)
	}
	if len(spaces) == 0 {
		t.Fatal("the custody list is empty: an org admin must see every space in the org, private ones included")
	}
	allowed := map[string]bool{
		"id": true, "slug": true, "name": true, "ownerIds": true,
		"visibility": true, "memberCount": true, "archivedAt": true,
	}
	for _, sp := range spaces {
		for key := range sp {
			if !allowed[key] {
				t.Errorf("the custody view carries %q, which is not on the allow-list — custody is metadata, never anything said in the space", key)
			}
		}
	}
}

// TestCustodySpaceReportsEveryOwner: ownership is a set, and a view that named
// one owner would misreport every co-owned space.
func TestCustodySpaceReportsEveryOwner(t *testing.T) {
	srv, _, admin, _ := custodyServer(t)
	slug, owner, ownerID, passcode := privateSpace(t, srv)

	ids := []string{ownerID}
	for _, name := range []string{"Second", "Third"} {
		cookie, id := signupWithID(t, srv, name)
		custodyJoin(t, srv, slug, passcode, cookie)
		if resp, body := setRole(t, srv, slug, id, store.RoleOwner, owner); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("promote = %d %s", resp.StatusCode, body)
		}
		ids = append(ids, id)
	}

	_, spaces := custodyList(t, srv, admin)
	for _, sp := range spaces {
		if string(sp["slug"]) != `"`+slug+`"` {
			continue
		}
		var owners []string
		json.Unmarshal(sp["ownerIds"], &owners)
		if len(owners) != 3 {
			t.Fatalf("ownerIds = %v, want all three of %v", owners, ids)
		}
		for _, want := range ids {
			if !strings.Contains(strings.Join(owners, ","), want) {
				t.Errorf("ownerIds %v is missing owner %s", owners, want)
			}
		}
		return
	}
	t.Fatalf("the custody list does not contain %s", slug)
}

// TestCustodyCannotWidenVisibilityThenJoin walks the whole escalation and
// asserts it stops at the first step. Widening is what makes every later step
// possible: an org-visible space with no passcode is joinable by any org
// member, and joining is roster, presence, votes and standup entries.
func TestCustodyCannotWidenVisibilityThenJoin(t *testing.T) {
	ctx := context.Background()
	srv, pool, admin, adminID := custodyServer(t)
	slug, _, _, _ := privateSpace(t, srv)

	resp, body := custodyDo(t, srv, "PATCH", "/spaces/"+slug, `{"visibility":"org"}`, admin)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("custody widening private -> org = %d, want 403: only a space owner may widen (%v)", resp.StatusCode, body)
	}

	var visibility string
	if err := pool.QueryRow(ctx, "select visibility from spaces where slug = $1", slug).Scan(&visibility); err != nil {
		t.Fatal(err)
	}
	if visibility != store.VisibilityPrivate {
		t.Fatalf("visibility = %q after a refused widening, want private", visibility)
	}

	// The second step, attempted anyway: the space must still be invisible in
	// the directory the admin would have to find it through.
	req, _ := http.NewRequest("GET", srv.URL+"/api/orgs/"+store.DefaultOrgSlug+"/spaces", nil)
	req.AddCookie(admin)
	listing, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(listing.Body)
	listing.Body.Close()
	if strings.Contains(string(raw), slug) {
		t.Fatalf("the org directory lists %s to an admin who is not a member of it: %s", slug, raw)
	}

	// The second step, attempted anyway rather than assumed unreachable: the
	// admin does not hold the passcode either, so the walk fails twice over.
	if got, err := requestStatus(srv, "POST",
		"/api/orgs/"+store.DefaultOrgSlug+"/spaces/"+slug+"/join", "{}", admin); err != nil || got != http.StatusForbidden {
		t.Fatalf("the admin joining after a refused widening = %d (%v), want 403", got, err)
	}

	// And membership itself never happened, whatever else the admin tried.
	var member bool
	if err := pool.QueryRow(ctx,
		"select exists (select 1 from members m join spaces sp on sp.id = m.space_id where sp.slug = $1 and m.user_id = $2)",
		slug, adminID).Scan(&member); err != nil {
		t.Fatal(err)
	}
	if member {
		t.Fatal("the org admin ended up a member of a private space they were never in")
	}
}

// TestCustodyOwnershipIsGrantedToMembersOnly. Naming themself, or anyone not
// already in the space, is the privilege-escalation path the purity of the
// custody handlers does not close: the follow-up request goes through the
// ordinary member routes.
func TestCustodyOwnershipIsGrantedToMembersOnly(t *testing.T) {
	srv, _, admin, adminID := custodyServer(t)
	slug, _, _, _ := privateSpace(t, srv)
	_, strangerID := signupWithID(t, srv, "Stranger")

	for name, target := range map[string]string{
		"themself":               adminID,
		"someone else not in it": strangerID,
	} {
		resp, body := custodyDo(t, srv, "POST", "/spaces/"+slug+"/owners", `{"userId":"`+target+`"}`, admin)
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("granting ownership to %s = %d, want 403 (%v)", name, resp.StatusCode, body)
		}
	}
}

// TestAnOrgAdminInsideASpaceStillCannotPromoteThemself. An admin who is also
// an ordinary member of the space — somebody promoted to org admin after
// having joined a room — is the only shape that reaches the self-grant refusal
// at all: for an admin who is not a member, the members-only rule refuses the
// same request first, and the check would be dead code.
func TestAnOrgAdminInsideASpaceStillCannotPromoteThemself(t *testing.T) {
	ctx := context.Background()
	srv, pool, admin, adminID := custodyServer(t)
	slug, _, _, passcode := privateSpace(t, srv)
	custodyJoin(t, srv, slug, passcode, admin)

	resp, body := custodyDo(t, srv, "POST", "/spaces/"+slug+"/owners", `{"userId":"`+adminID+`"}`, admin)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("an org admin who is a member granting themself ownership = %d, want 403 (%v)", resp.StatusCode, body)
	}
	var role string
	if err := pool.QueryRow(ctx,
		"select m.role from members m join spaces sp on sp.id = m.space_id where sp.slug = $1 and m.user_id = $2",
		slug, adminID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != store.RoleMember {
		t.Fatalf("the admin's role in the space is %q — custody is management, not membership, and an admin never promotes themself", role)
	}
}

// TestCustodyOwnershipGrantIsAdditive: custody repairs "our only owner left",
// it never decides who runs a room the admin is not in.
func TestCustodyOwnershipGrantIsAdditive(t *testing.T) {
	ctx := context.Background()
	srv, pool, admin, _ := custodyServer(t)
	slug, _, ownerID, passcode := privateSpace(t, srv)

	second, secondID := signupWithID(t, srv, "Second")
	custodyJoin(t, srv, slug, passcode, second)

	resp, body := custodyDo(t, srv, "POST", "/spaces/"+slug+"/owners", `{"userId":"`+secondID+`"}`, admin)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("granting ownership to a member = %d, want 204 (%v)", resp.StatusCode, body)
	}

	roles := map[string]string{}
	rows, err := pool.Query(ctx,
		"select m.user_id, m.role from members m join spaces sp on sp.id = m.space_id where sp.slug = $1", slug)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			t.Fatal(err)
		}
		roles[id] = role
	}
	rows.Close()
	if roles[ownerID] != store.RoleOwner {
		t.Errorf("the incumbent owner's role is %q after a custody grant, want owner — custody never demotes", roles[ownerID])
	}
	if roles[secondID] != store.RoleOwner {
		t.Errorf("the promoted member's role is %q, want owner", roles[secondID])
	}
}

// TestClaimingIsRefusedWhileAnyMemberRemains, and audited when it succeeds.
// This is the one path by which an org admin becomes a member of a space they
// were not in, so the record of it is the control that makes it acceptable.
func TestClaimingIsRefusedWhileAnyMemberRemains(t *testing.T) {
	ctx := context.Background()
	srv, pool, admin, adminID := custodyServer(t)
	slug, _, _, _ := privateSpace(t, srv)

	resp, body := custodyDo(t, srv, "POST", "/spaces/"+slug+"/claim", "", admin)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("claiming a space that still has members = %d, want 409 (%v)", resp.StatusCode, body)
	}

	if _, err := pool.Exec(ctx,
		"delete from members m using spaces sp where sp.id = m.space_id and sp.slug = $1", slug); err != nil {
		t.Fatal(err)
	}
	resp, body = custodyDo(t, srv, "POST", "/spaces/"+slug+"/claim", "", admin)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("claiming an abandoned space = %d, want 204 (%v)", resp.StatusCode, body)
	}

	var records int
	if err := pool.QueryRow(ctx,
		"select count(*) from org_audit_log where action = 'space.claim' and space_slug = $1 and actor_id = $2",
		slug, adminID).Scan(&records); err != nil {
		t.Fatal(err)
	}
	if records != 1 {
		t.Fatalf("%d audit records for the claim, want 1", records)
	}
}

// TestAnOrgAdminIsAStrangerInsideTheSpace. Asserting only that they are absent
// from the roster would be vacuous — the roster selects from members — so this
// asks the routes an admin would actually try.
func TestAnOrgAdminIsAStrangerInsideTheSpace(t *testing.T) {
	srv, _, admin, _ := custodyServer(t)
	slug, owner, ownerID, _ := privateSpace(t, srv)
	_, sess := createSession(t, srv, slug, "poker", "Private round", owner)
	sessionID := sess["id"].(string)

	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/api/sessions/" + sessionID, ""},
		{"GET", "/api/sessions/" + sessionID + "/export.csv", ""},
		{"POST", "/api/orgs/" + store.DefaultOrgSlug + "/spaces/" + slug + "/members/" + ownerID + "/role", `{"role":"member"}`},
		{"DELETE", "/api/orgs/" + store.DefaultOrgSlug + "/spaces/" + slug + "/members/" + ownerID, ""},
	} {
		got, err := requestStatus(srv, tc.method, tc.path, tc.body, admin)
		if err != nil {
			t.Fatal(err)
		}
		if got != http.StatusNotFound {
			t.Errorf("%s %s as an org admin who is not a space member = %d, want 404", tc.method, tc.path, got)
		}
	}

	ws, resp, err := dialWS(t, srv, sessionID, admin, "")
	if err == nil {
		ws.Close()
		t.Fatal("an org admin who is not a space member opened the room's WebSocket")
	}
	if resp != nil && resp.StatusCode == http.StatusSwitchingProtocols {
		t.Fatalf("the socket upgrade succeeded for a non-member: %d", resp.StatusCode)
	}
}

// TestRevokingASoleOwnerPromotesOrRefuses. A cross-space bulk delete bypasses
// mutateMembership entirely, and 0015 says outright that an ownerless space
// can never be managed by anyone again.
func TestRevokingASoleOwnerPromotesOrRefuses(t *testing.T) {
	ctx := context.Background()
	srv, pool, admin, _ := custodyServer(t)
	slug, _, ownerID, passcode := privateSpace(t, srv)

	// No other member: there is nobody to promote, so the revoke must refuse
	// and name the space rather than strand it.
	resp, body := doJSON(t, srv, "DELETE", custodyPath+"/members/"+ownerID, "", admin)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("revoking the sole owner of a space = %d, want 409 (%v)", resp.StatusCode, body)
	}
	if !strings.Contains(strings.ToLower(string(mustJSON(t, body))), slug) {
		t.Errorf("the refusal does not name the blocking space %s: %v", slug, body)
	}
	var stillRevoked bool
	if err := pool.QueryRow(ctx,
		"select exists (select 1 from org_members where user_id = $1 and revoked_at is not null)", ownerID).Scan(&stillRevoked); err != nil {
		t.Fatal(err)
	}
	if stillRevoked {
		t.Fatal("a refused revoke still wrote the tombstone")
	}

	// With somebody left behind, the same revoke promotes them instead.
	second, secondID := signupWithID(t, srv, "Second")
	custodyJoin(t, srv, slug, passcode, second)
	resp, body = doJSON(t, srv, "DELETE", custodyPath+"/members/"+ownerID, "", admin)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoking an owner with somebody to promote = %d, want 204 (%v)", resp.StatusCode, body)
	}
	var role string
	if err := pool.QueryRow(ctx,
		"select m.role from members m join spaces sp on sp.id = m.space_id where sp.slug = $1 and m.user_id = $2",
		slug, secondID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != store.RoleOwner {
		t.Fatalf("the remaining member's role is %q, want owner — the space must never be left ownerless", role)
	}
	var owners int
	if err := pool.QueryRow(ctx,
		"select count(*) from members m join spaces sp on sp.id = m.space_id where sp.slug = $1 and m.role = 'owner'", slug).Scan(&owners); err != nil {
		t.Fatal(err)
	}
	if owners == 0 {
		t.Fatal("the space is ownerless after a revoke")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestRevokeBlocksAFirstSignInAndUnRevokeRestoresIt. Revocation upserts the
// tombstone: an admin may revoke someone who has no org_members row yet, where
// an update would affect zero rows and the next sign-in would insert a clean
// one.
func TestRevokeBlocksAFirstSignInAndUnRevokeRestoresIt(t *testing.T) {
	ctx := context.Background()
	srv, pool, admin, _ := custodyServer(t)

	orgs := &store.Orgs{Pool: pool}
	org, err := orgs.Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, hash := store.NewToken()
	newcomer, err := (&store.Users{Pool: pool}).Create(ctx, "Newcomer", hash)
	if err != nil {
		t.Fatal(err)
	}
	// Nobody has enrolled them: there is no org_members row to update.
	if _, err := pool.Exec(ctx, "delete from org_members where user_id = $1", newcomer.ID); err != nil {
		t.Fatal(err)
	}

	if got, err := requestStatus(srv, "DELETE", custodyPath+"/members/"+newcomer.ID, "", admin); err != nil || got != http.StatusNoContent {
		t.Fatalf("revoking somebody with no membership row = %d (%v), want 204", got, err)
	}
	// What a first sign-in does.
	if err := orgs.GrantMember(ctx, org.ID, newcomer.ID, store.OrgRoleMember); err != nil {
		t.Fatal(err)
	}
	member, err := orgs.IsMember(ctx, org.ID, newcomer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if member {
		t.Fatal("a first sign-in walked past the revocation tombstone")
	}

	if got, err := requestStatus(srv, "POST", custodyPath+"/members/"+newcomer.ID+"/restore", "", admin); err != nil || got != http.StatusNoContent {
		t.Fatalf("un-revoking = %d (%v), want 204", got, err)
	}
	if err := orgs.GrantMember(ctx, org.ID, newcomer.ID, store.OrgRoleMember); err != nil {
		t.Fatal(err)
	}
	member, err = orgs.IsMember(ctx, org.ID, newcomer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !member {
		t.Fatal("un-revoking did not restore membership on the next sign-in")
	}
}

// TestTheLastOrgAdminCannotBeRemovedOrDemoted, matching the ErrLastOwner
// precedent: an org nobody can administer can never be recovered.
func TestTheLastOrgAdminCannotBeRemovedOrDemoted(t *testing.T) {
	srv, _, admin, adminID := custodyServer(t)

	resp, body := custodyDo(t, srv, "POST", "/members/"+adminID+"/role", `{"role":"member"}`, admin)
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("demoting the last org admin = %d, want 409 (%v)", resp.StatusCode, body)
	}
	resp, body = doJSON(t, srv, "DELETE", custodyPath+"/members/"+adminID, "", admin)
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("revoking the last org admin = %d, want 409 (%v)", resp.StatusCode, body)
	}
}

// TestASpaceCannotBeDrivenToZeroMembersAndThenClaimed. Removing members one at
// a time is refused at the last one, and no custody action removes them at all.
func TestASpaceCannotBeDrivenToZeroMembersAndThenClaimed(t *testing.T) {
	srv, _, admin, _ := custodyServer(t)
	slug, owner, ownerID, _ := privateSpace(t, srv)

	resp, body := removeMember(t, srv, slug, ownerID, owner)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("removing the last member (who is the last owner) = %d, want 409 (%s)", resp.StatusCode, body)
	}
	resp2, body2 := custodyDo(t, srv, "POST", "/spaces/"+slug+"/claim", "", admin)
	if resp2.StatusCode != http.StatusConflict {
		t.Fatalf("claiming a space that still has its owner = %d, want 409 (%v)", resp2.StatusCode, body2)
	}
}

// TestPurgeRequiresTheSlugAndReportsWhatItDestroys, and finishes the job: an
// org row left standing behind a restrict foreign key with every space gone is
// a failure, not a success.
func TestPurgeRequiresTheSlugAndReportsWhatItDestroys(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	// A second org, because purging the default one would leave the instance
	// with no org to fall back to.
	slug := "purgeable-" + randomSlugSuffix(t)
	var orgID string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Purgeable', $1) returning id", slug).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	admin, adminID := signupWithID(t, srv, "Admin")
	if _, err := pool.Exec(ctx,
		"insert into org_members (org_id, user_id, role) values ($1, $2, 'admin')", orgID, adminID); err != nil {
		t.Fatal(err)
	}
	spaceSlug := "doomed-" + randomSlugSuffix(t)
	var spaceID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (org_id, slug, name, creator_id) values ($1, $2, 'Doomed', $3) returning id",
		orgID, spaceSlug, adminID).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into sessions (space_id, kind, title, facilitator_id, config) values ($1, 'poker', 'Round', $2, '{}')",
		spaceID, adminID); err != nil {
		t.Fatal(err)
	}

	// The database refuses the naive delete: spaces.org_id is on delete restrict.
	if _, err := pool.Exec(ctx, "delete from orgs where id = $1", orgID); err == nil {
		t.Fatal("deleting an org that still owns spaces succeeded — the restrict foreign key is gone")
	}

	base := "/api/orgs/" + slug
	resp, body := doJSON(t, srv, "DELETE", base, `{"confirm":"not-the-slug"}`, admin)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("purge without the org slug = %d, want 400 (%v)", resp.StatusCode, body)
	}
	if body["spaces"] != float64(1) || body["sessions"] != float64(1) {
		t.Errorf("the refusal must state what it would destroy: got %v", body)
	}

	resp, body = doJSON(t, srv, "DELETE", base, `{"confirm":"`+slug+`"}`, admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("purge = %d, want 200 (%v)", resp.StatusCode, body)
	}
	if body["spaces"] != float64(1) || body["sessions"] != float64(1) {
		t.Errorf("purge reported %v, want one space and one session", body)
	}

	var orgs, spaces int
	if err := pool.QueryRow(ctx, "select count(*) from orgs where id = $1", orgID).Scan(&orgs); err != nil {
		t.Fatal(err)
	}
	if orgs != 0 {
		t.Fatal("the orgs row survived the purge")
	}
	if err := pool.QueryRow(ctx, "select count(*) from spaces where org_id = $1", orgID).Scan(&spaces); err != nil {
		t.Fatal(err)
	}
	if spaces != 0 {
		t.Fatal("spaces survived the purge")
	}

	// The audit record outlives everything it names, and still says what was
	// purged: that is what the non-cascading foreign keys buy.
	var auditOrg, auditAction string
	if err := pool.QueryRow(ctx,
		"select org_slug, action from org_audit_log where action = 'org.purge' and org_slug = $1", slug).
		Scan(&auditOrg, &auditAction); err != nil {
		t.Fatalf("the audit record did not survive the purge: %v", err)
	}
	srv.Close()
}

// TestArchivingRemovesASpaceFromTheDirectory. Archiving has to mean something
// or it is a column nobody reads; what it means is "stop listing this", and
// deliberately nothing more — the space, its members and its history survive
// and its own URL still works.
func TestArchivingRemovesASpaceFromTheDirectory(t *testing.T) {
	srv, _, admin, _ := custodyServer(t)
	slug, owner, _, _ := privateSpace(t, srv)

	// The owner sees it in the directory because they are a member of it: a
	// private space is listed to the people inside it and to nobody else.
	if !directoryLists(t, srv, owner, slug) {
		t.Fatal("an org-visible space is missing from the directory before archiving")
	}

	if got, err := requestStatus(srv, "PATCH", custodyPath+"/spaces/"+slug, `{"archived":true}`, admin); err != nil || got != http.StatusNoContent {
		t.Fatalf("archive = %d (%v), want 204", got, err)
	}
	if directoryLists(t, srv, owner, slug) {
		t.Fatal("an archived space is still listed in the org directory")
	}

	if got, err := requestStatus(srv, "PATCH", custodyPath+"/spaces/"+slug, `{"archived":false}`, admin); err != nil || got != http.StatusNoContent {
		t.Fatalf("unarchive = %d (%v), want 204", got, err)
	}
	if !directoryLists(t, srv, owner, slug) {
		t.Fatal("un-archiving did not restore the space to the directory")
	}
}

func directoryLists(t *testing.T, srv *httptest.Server, cookie *http.Cookie, slug string) bool {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/orgs/"+store.DefaultOrgSlug+"/spaces", nil)
	req.AddCookie(cookie)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return strings.Contains(string(raw), `"`+slug+`"`)
}

// TestOrgRevokeClosesASocketOnAnotherReplica is the cross-replica half of
// revocation. Hub.DisconnectSpaceMember only reaches the process it runs in,
// and revokeChannel is keyed by session token and fires on logout alone, so
// without parley_member_revoke a revoked member keeps a live, authenticated
// socket on every other replica until that connection's revalidation tick
// notices — at most hub's maxRevalidate, 30s. Asserting inside
// revokeAssertWindow is what separates the fanout from that backstop.
func TestOrgRevokeClosesASocketOnAnotherReplica(t *testing.T) {
	srvA := testServer(t)
	srvB := secondInstance(t)

	_, member, sessionID := setupSession(t, srvA, "Revoked Member Space")
	_, me := doJSON(t, srvA, "GET", "/api/me", "", member)
	memberID, _ := me["id"].(string)
	if memberID == "" {
		t.Fatalf("no member id: %v", me)
	}
	admin, adminID := signupWithID(t, srvA, "Admin")
	makeOrgAdmin(t, testDBPool(t), adminID)

	waitReady(t, srvB, true, 10*time.Second)
	wsB, _, err := dialWS(t, srvB, sessionID, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsB.Close()
	consumePresenceFrames(t, wsB)

	// The revoke is served by A, which holds none of this member's sockets.
	if got, err := requestStatus(srvA, "DELETE", custodyPath+"/members/"+memberID, "", admin); err != nil || got != http.StatusNoContent {
		t.Fatalf("revoke on A = %d (%v), want 204", got, err)
	}

	awaitRevoked(t, wsB, "an org revoke served by instance A never closed the socket held by instance B")
}
