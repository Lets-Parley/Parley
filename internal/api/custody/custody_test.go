package custody

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/dbtest"
)

// forbiddenDeps are the packages a custody handler must not be able to reach.
// The list is by import path rather than by symbol because that is what makes
// the guarantee structural: a type that holds what was said in a space cannot
// be named here if the package declaring it is not linked in at all.
var forbiddenDeps = []string{
	"github.com/lets-parley/parley/internal/session",
	"github.com/lets-parley/parley/internal/poker",
	"github.com/lets-parley/parley/internal/standup",
	"github.com/lets-parley/parley/internal/hub",
	"github.com/lets-parley/parley/internal/store",
}

// TestCustodyDependsOnNothingSessionShaped is the purity guarantee, and it is
// a whole-package load on purpose. A file-scoped `go list -deps custody.go`
// would build an ad-hoc command-line-arguments package that never resolves
// identifiers declared in sibling files, so a handler reaching a field typed
// elsewhere in the package would show zero dependencies and pass.
func TestCustodyDependsOnNothingSessionShaped(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", "./...").Output()
	if err != nil {
		t.Fatalf("go list -deps: %v", err)
	}
	deps := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		deps[strings.TrimSpace(line)] = true
	}
	if !deps["github.com/lets-parley/parley/internal/api/custody"] {
		t.Fatal("go list did not report the custody package itself — the check has stopped looking at anything")
	}
	for _, forbidden := range forbiddenDeps {
		if deps[forbidden] {
			t.Errorf("internal/api/custody depends on %s — custody is management without access, and that dependency is how a handler here would reach what was said in a space", forbidden)
		}
	}
}

// TestCustodyConstantsMatchTheStore is the price of not importing
// internal/store: the vocabulary is duplicated, so something has to notice
// when the two drift. It reads the source rather than importing the package,
// for the same reason the package itself does not.
func TestCustodyConstantsMatchTheStore(t *testing.T) {
	raw, err := os.ReadFile("../../store/spaces.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	for name, value := range map[string]string{
		"VisibilityPrivate": visibilityPrivate,
		"VisibilityOrg":     visibilityOrg,
		"RoleOwner":         roleOwner,
		"RoleMember":        roleMember,
	} {
		if !declares(src, name, value) {
			t.Errorf("store.%s is no longer %q — the copy in this package has drifted from the CHECK constraint it mirrors", name, value)
		}
	}
	orgs, err := os.ReadFile("../../store/orgs.go")
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"OrgRoleAdmin":   orgRoleAdmin,
		"OrgRoleMember":  orgRoleMember,
		"DefaultOrgSlug": defaultOrgSlug,
	} {
		if !declares(string(orgs), name, value) {
			t.Errorf("store.%s is no longer %q — the copy in this package has drifted", name, value)
		}
	}
}

// declares matches a constant declaration whatever gofmt has done to the
// alignment around the equals sign.
func declares(src, name, value string) bool {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\s*=\s*"` + regexp.QuoteMeta(value) + `"`).MatchString(src)
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(context.Background(), pool, slog.New(slog.NewTextHandler(os.Stderr, nil)), db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	return pool
}

// queryCounter counts the statements a call sends to the server, `begin` and
// `commit` included: they are round trips too, and the whole point of batching
// this work is that the transaction is held open across fewer of them.
type queryCounter struct{ n int }

func (c *queryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.n++
	return ctx
}

func (c *queryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func countingPool(t *testing.T, counter *queryCounter) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestARevokeCostsTheSameNumberOfRoundTripsWhateverTheSpaceCount. The per-space
// work is what stops a space being stranded ownerless, but the data is
// set-shaped: choosing every successor and promoting them is two statements
// whether the person is in two spaces or twenty. A revoke whose cost grows with
// the membership holds one transaction open across every one of those trips.
func TestARevokeCostsTheSameNumberOfRoundTripsWhateverTheSpaceCount(t *testing.T) {
	ctx := context.Background()
	// Migrations run once, off the pool whose statements are not counted.
	testPool(t)
	counter := &queryCounter{}
	pool := countingPool(t, counter)

	revokeAcross := func(spaces int) int {
		orgID, orgSlug := newOrg(t, pool, fmt.Sprintf("roundtrips%d", spaces))
		newUser := func(name string) string {
			var id string
			if err := pool.QueryRow(ctx, "insert into users (name) values ($1) returning id", name).Scan(&id); err != nil {
				t.Fatal(err)
			}
			return id
		}
		adminID, ownerID := newUser("Admin"), newUser("Owner")
		for id, role := range map[string]string{adminID: "admin", ownerID: "member"} {
			if _, err := pool.Exec(ctx,
				"insert into org_members (org_id, user_id, role) values ($1, $2, $3)", orgID, id, role); err != nil {
				t.Fatal(err)
			}
		}
		var spaceIDs []string
		for i := range spaces {
			spaceID := newSpace(t, pool, orgID, fmt.Sprintf("%s-%d", orgSlug, i))
			spaceIDs = append(spaceIDs, spaceID)
			if _, err := pool.Exec(ctx,
				"insert into members (space_id, user_id, role) values ($1, $2, 'owner')", spaceID, ownerID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx,
				"insert into members (space_id, user_id, role) values ($1, $2, 'member')", spaceID, newUser("Successor")); err != nil {
				t.Fatal(err)
			}
		}

		store := &Store{Pool: pool}
		before := counter.n
		removed, blocked, err := store.RevokeOrgMember(ctx, Scope{OrgID: orgID, OrgSlug: orgSlug, ActorID: adminID}, ownerID)
		cost := counter.n - before
		if err != nil {
			t.Fatalf("revoke across %d spaces: %v (blocked %v)", spaces, err, blocked)
		}
		t.Logf("a revoke across %d spaces cost %d round trips", spaces, cost)
		if len(removed) != spaces {
			t.Fatalf("removed = %v, want all %d spaces", removed, spaces)
		}
		// Every one of them keeps an owner: batching may not cost a space its
		// last-owner protection.
		for _, spaceID := range spaceIDs {
			var owners int
			if err := pool.QueryRow(ctx,
				"select count(*) from members where space_id = $1 and role = 'owner'", spaceID).Scan(&owners); err != nil {
				t.Fatal(err)
			}
			if owners != 1 {
				t.Fatalf("space %s has %d owners after the revoke, want exactly the promoted successor", spaceID, owners)
			}
		}
		return cost
	}

	few, many := revokeAcross(2), revokeAcross(8)
	if many != few {
		t.Fatalf("revoking a member of 8 spaces took %d round trips against %d for 2 — the per-space work is still serial", many, few)
	}
}

// TestAnInterruptedPurgeLeavesEverythingStanding runs the destructive half
// inside a transaction the test then aborts. It matters more here than
// anywhere else in the codebase: spaces.org_id is `on delete restrict`, so a
// purge that got halfway would leave some spaces gone, the rest standing, and
// the org row undeletable — with no described way back.
func TestAnInterruptedPurgeLeavesEverythingStanding(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	store := &Store{Pool: pool}

	suffix := strings.ToLower(strings.ReplaceAll(t.Name(), "_", ""))
	orgSlug := "interrupted-" + suffix[len(suffix)-8:]
	var orgID string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Interrupted', $1) returning id", orgSlug).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), "delete from spaces where org_id = $1", orgID)
		pool.Exec(context.Background(), "delete from orgs where id = $1", orgID)
		// The audit record deliberately outlives the org it names, and this
		// test's org slug is derived from its own name: without this a second
		// run against the same database would count the first run's record.
		pool.Exec(context.Background(), "delete from org_audit_log where org_slug = $1", orgSlug)
	})
	for _, name := range []string{"one", "two"} {
		if _, err := pool.Exec(ctx,
			"insert into spaces (org_id, slug, name) values ($1, $2, $3)", orgID, orgSlug+"-"+name, name); err != nil {
			t.Fatal(err)
		}
	}
	scope := Scope{OrgID: orgID, OrgSlug: orgSlug}

	counts, err := func() (Counts, error) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return Counts{}, err
		}
		defer tx.Rollback(ctx)
		counts, err := purgeTx(ctx, tx, scope, nil)
		if err != nil {
			return counts, err
		}
		// The interruption: everything the purge did is discarded here.
		return counts, tx.Rollback(ctx)
	}()
	if err != nil {
		t.Fatal(err)
	}
	if counts.Spaces != 2 {
		t.Fatalf("the purge counted %d spaces, want 2", counts.Spaces)
	}

	var orgs, spaces, records int
	if err := pool.QueryRow(ctx, "select count(*) from orgs where id = $1", orgID).Scan(&orgs); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "select count(*) from spaces where org_id = $1", orgID).Scan(&spaces); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "select count(*) from org_audit_log where org_slug = $1", orgSlug).Scan(&records); err != nil {
		t.Fatal(err)
	}
	if orgs != 1 || spaces != 2 {
		t.Fatalf("an aborted purge left %d orgs and %d spaces, want 1 and 2", orgs, spaces)
	}
	if records != 0 {
		t.Fatalf("an aborted purge left %d audit records behind, want 0 — it did not happen", records)
	}

	// And the committed path still finishes the job, org row included.
	if _, err := store.Purge(ctx, scope, orgSlug); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if err := pool.QueryRow(ctx, "select count(*) from orgs where id = $1", orgID).Scan(&orgs); err != nil {
		t.Fatal(err)
	}
	if orgs != 0 {
		t.Fatal("the orgs row survived a committed purge")
	}
}

// newOrg creates an empty org to purge. Never the default one: purging that
// would leave the instance with nowhere to put a new space.
func newOrg(t *testing.T, pool *pgxpool.Pool, prefix string) (id, slug string) {
	t.Helper()
	slug = fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	if err := pool.QueryRow(context.Background(),
		"insert into orgs (slug, name, claim_value) values ($1, $2, $1) returning id", slug, prefix).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), "delete from spaces where org_id = $1", id)
		pool.Exec(context.Background(), "delete from orgs where id = $1", id)
	})
	return id, slug
}

func newSpace(t *testing.T, pool *pgxpool.Pool, orgID, slug string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		"insert into spaces (org_id, slug, name) values ($1, $2, $2) returning id", orgID, slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestThePurgeReportsTheSpacesItActuallyDestroyed. The count and the delete
// were two statements, and under read committed a space committed between them
// was destroyed without ever being counted: the operator was told "this will
// destroy 1 space" and 2 went. For the most destructive route in the codebase
// the number has to be true, so it now comes back from the delete itself.
func TestThePurgeReportsTheSpacesItActuallyDestroyed(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgID, orgSlug := newOrg(t, pool, "racedpurge")
	newSpace(t, pool, orgID, orgSlug+"-first")

	// Somebody else creates a space in the org, and commits, in the window
	// between the purge counting and the purge deleting.
	store := &Store{Pool: pool, hooks: purgeHooks{afterCount: func(ctx context.Context) error {
		newSpace(t, pool, orgID, orgSlug+"-second")
		return nil
	}}}
	counts, err := store.Purge(ctx, Scope{OrgID: orgID, OrgSlug: orgSlug}, orgSlug)
	if err != nil {
		t.Fatal(err)
	}

	var survivors int
	if err := pool.QueryRow(ctx, "select count(*) from spaces where slug like $1", orgSlug+"-%").Scan(&survivors); err != nil {
		t.Fatal(err)
	}
	if survivors != 0 {
		t.Fatalf("%d spaces survived the purge", survivors)
	}
	if counts.Spaces != 2 {
		t.Fatalf("the purge destroyed 2 spaces and reported %d — a purge must report what it destroyed, not what it expected to", counts.Spaces)
	}
	var detail string
	if err := pool.QueryRow(ctx,
		"select detail from org_audit_log where action = 'org.purge' and org_slug = $1", orgSlug).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "2 spaces") {
		t.Fatalf("the audit record says %q, and the purge destroyed 2 spaces", detail)
	}
}

// TestAPurgeRefusesWhenTheOrgRowIsAlreadyGone. Deleting every space and then
// failing the final delete on a lingering foreign key — or on an org row that
// is no longer there — is a failure, not a success, and the whole transaction
// has to go back. The hook is the only way in: the audit record's foreign key
// means no ordinary sequence of calls can reach the final delete with the org
// row missing.
func TestAPurgeRefusesWhenTheOrgRowIsAlreadyGone(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgID, orgSlug := newOrg(t, pool, "vanishedorg")
	newSpace(t, pool, orgID, orgSlug+"-only")

	store := &Store{Pool: pool, hooks: purgeHooks{beforeOrgDelete: func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "delete from orgs where id = $1", orgID)
		return err
	}}}
	if _, err := store.Purge(ctx, Scope{OrgID: orgID, OrgSlug: orgSlug}, orgSlug); err == nil {
		t.Fatal("a purge whose final delete removed no org row reported success")
	}

	assertPurgeLeftEverythingStanding(t, pool, orgID, orgSlug, 1)
}

// TestPurgeRollsBackItsOwnTransaction. purgeTx being correct proves nothing
// about Purge's Begin/Commit/Rollback wiring around it: the failure has to
// happen inside a transaction Purge itself opened.
func TestPurgeRollsBackItsOwnTransaction(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgID, orgSlug := newOrg(t, pool, "abandonedpurge")
	newSpace(t, pool, orgID, orgSlug+"-only")

	boom := errors.New("the purge could not finish")
	store := &Store{Pool: pool, hooks: purgeHooks{beforeOrgDelete: func(context.Context, pgx.Tx) error { return boom }}}
	if _, err := store.Purge(ctx, Scope{OrgID: orgID, OrgSlug: orgSlug}, orgSlug); !errors.Is(err, boom) {
		t.Fatalf("purge = %v, want the failure it hit", err)
	}

	assertPurgeLeftEverythingStanding(t, pool, orgID, orgSlug, 1)
}

func assertPurgeLeftEverythingStanding(t *testing.T, pool *pgxpool.Pool, orgID, orgSlug string, spaces int) {
	t.Helper()
	ctx := context.Background()
	var gotOrgs, gotSpaces, records int
	if err := pool.QueryRow(ctx, "select count(*) from orgs where id = $1", orgID).Scan(&gotOrgs); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "select count(*) from spaces where org_id = $1", orgID).Scan(&gotSpaces); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "select count(*) from org_audit_log where org_slug = $1", orgSlug).Scan(&records); err != nil {
		t.Fatal(err)
	}
	if gotOrgs != 1 || gotSpaces != spaces {
		t.Fatalf("a failed purge left %d orgs and %d spaces, want 1 and %d", gotOrgs, gotSpaces, spaces)
	}
	if records != 0 {
		t.Fatalf("a failed purge left %d audit records behind, want 0 — it did not happen", records)
	}
}

// newUser inserts a bare account and returns its id.
func newUser(t *testing.T, pool *pgxpool.Pool, name string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		"insert into users (name) values ($1) returning id", name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// joinOrg enrols somebody in the org with the given role.
func joinOrg(t *testing.T, pool *pgxpool.Pool, orgID, userID, role string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"insert into org_members (org_id, user_id, role) values ($1, $2, $3)", orgID, userID, role); err != nil {
		t.Fatal(err)
	}
}

// joinSpace puts somebody in a space with an explicit last_seen_at, which is
// the first half of 0015's promotion rule and so has to be set by hand rather
// than left to the column default every row would share.
func joinSpace(t *testing.T, pool *pgxpool.Pool, spaceID, userID, role string, seen time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"insert into members (space_id, user_id, role, last_seen_at) values ($1, $2, $3, $4)",
		spaceID, userID, role, seen); err != nil {
		t.Fatal(err)
	}
}

// spaceOwners reads back who owns a space.
func spaceOwners(t *testing.T, pool *pgxpool.Pool, spaceID string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		"select user_id::text from members where space_id = $1 and role = 'owner' order by user_id", spaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	owners := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		owners = append(owners, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return owners
}

// TestTheSuccessorTiebreakSurvivesMultipleSpaces. 0015 chose the most recent
// last_seen_at and the user_id as the tiebreak so that promotion never depends
// on the order the rows happen to come back in; candidates last seen at the
// same instant are the only case that can tell the two apart.
//
// One space is not enough to prove it. With a single space and every candidate
// tied, the scan the planner picks is ordered by members_pkey — (space_id,
// user_id) — and Postgres leaves an already-ordered input alone, so the right
// person is promoted by coincidence even with `, m.user_id` deleted from the
// ORDER BY. This fixture removes both coincidences: several spaces revoked at
// once, so the batched `distinct on` sorts rows from all of them together, and
// two distinct last_seen_at values interleaved through each space's membership
// so the input is not presorted and the tie group is genuinely reordered.
// Deleting the tiebreak has to leave the promotion to whatever the sort spat
// out first, in every one of the spaces at once.
func TestTheSuccessorTiebreakSurvivesMultipleSpaces(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgID, orgSlug := newOrg(t, pool, "tiebreak")

	adminID := newUser(t, pool, "Admin")
	ownerID := newUser(t, pool, "Owner")
	joinOrg(t, pool, orgID, adminID, "admin")
	joinOrg(t, pool, orgID, ownerID, "member")

	// Tied candidates were last seen now; the stale ones an hour ago. Only the
	// tied group is eligible to win, and inside it only the user_id decides.
	fresh := time.Now().UTC()
	stale := fresh.Add(-time.Hour)

	const spaces, perGroup = 6, 24
	want := map[string]string{}
	spaceIDs := []string{}
	for s := range spaces {
		spaceID := newSpace(t, pool, orgID, fmt.Sprintf("%s-space-%d", orgSlug, s))
		spaceIDs = append(spaceIDs, spaceID)
		joinSpace(t, pool, spaceID, ownerID, "owner", fresh)

		tied, old := []string{}, []string{}
		for i := range perGroup {
			tied = append(tied, newUser(t, pool, fmt.Sprintf("Tied %d-%d", s, i)))
			old = append(old, newUser(t, pool, fmt.Sprintf("Stale %d-%d", s, i)))
		}
		// Highest id first inside the tie group, so a promotion that took
		// whatever was written first would take the wrong one, and the two
		// groups interleaved so no scan hands the sort a presorted input.
		sort.Sort(sort.Reverse(sort.StringSlice(tied)))
		for i := range perGroup {
			joinSpace(t, pool, spaceID, tied[i], "member", fresh)
			joinSpace(t, pool, spaceID, old[i], "member", stale)
		}
		want[spaceID] = tied[len(tied)-1]
	}

	store := &Store{Pool: pool}
	removed, blocked, err := store.RevokeOrgMember(ctx, Scope{OrgID: orgID, OrgSlug: orgSlug, ActorID: adminID}, ownerID)
	if err != nil {
		t.Fatalf("revoke: %v (blocked %v)", err, blocked)
	}
	// The reported ids are what the caller aims a disconnect at, so they have
	// to be the spaces the revoke actually emptied — no more, no less.
	if len(removed) != spaces {
		t.Fatalf("removed = %v, want all %d spaces", removed, spaces)
	}

	for _, spaceID := range spaceIDs {
		owners := spaceOwners(t, pool, spaceID)
		if len(owners) != 1 || owners[0] != want[spaceID] {
			t.Errorf("space %s was handed to %v, want exactly %s — with equal last_seen_at the lowest user_id takes it, not whatever the scan returned first",
				spaceID, owners, want[spaceID])
		}
	}
}

// TestTheSuccessorIsTheMostRecentlySeen pins the other half of 0015's rule.
// The tiebreak test alone cannot: every candidate in it is tied, so a query
// sorting last_seen_at the wrong way round still picks the same person. Here
// the stale candidate holds the *lower* user_id, so a promotion that ignored
// recency — or read it ascending — would hand the space to somebody who has
// not been near it for a day, and the tiebreak would agree with the mistake.
func TestTheSuccessorIsTheMostRecentlySeen(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgID, orgSlug := newOrg(t, pool, "recency")
	spaceID := newSpace(t, pool, orgID, orgSlug+"-space")

	adminID := newUser(t, pool, "Admin")
	ownerID := newUser(t, pool, "Owner")
	joinOrg(t, pool, orgID, adminID, "admin")
	joinOrg(t, pool, orgID, ownerID, "member")
	joinSpace(t, pool, spaceID, ownerID, "owner", time.Now().UTC())

	// Two candidates whose ids are known to be the wrong way round for the
	// answer: the stale one sorts first by user_id, so only recency can pick
	// the right successor.
	staleID, freshID := newUser(t, pool, "Candidate"), newUser(t, pool, "Candidate")
	if staleID > freshID {
		staleID, freshID = freshID, staleID
	}
	joinSpace(t, pool, spaceID, staleID, "member", time.Now().UTC().Add(-24*time.Hour))
	joinSpace(t, pool, spaceID, freshID, "member", time.Now().UTC())

	store := &Store{Pool: pool}
	if _, blocked, err := store.RevokeOrgMember(ctx, Scope{OrgID: orgID, OrgSlug: orgSlug, ActorID: adminID}, ownerID); err != nil {
		t.Fatalf("revoke: %v (blocked %v)", err, blocked)
	}

	owners := spaceOwners(t, pool, spaceID)
	if len(owners) != 1 || owners[0] != freshID {
		t.Fatalf("the successor is %v, want %s — the most recently seen member takes the space, and the stale one only sorts first by user_id",
			owners, freshID)
	}
}

// TestRevokingOneOfTwoOwnersPromotesNobody. Promotion exists to stop a space
// being stranded, and a space with a second owner is not stranded. Promoting
// anyway would quietly hand ownership to a bystander nobody chose — a
// privilege escalation that arrives as a side effect of somebody else's
// revoke — so the owners-count check is a boundary, not an optimisation.
func TestRevokingOneOfTwoOwnersPromotesNobody(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgID, orgSlug := newOrg(t, pool, "twoowners")
	spaceID := newSpace(t, pool, orgID, orgSlug+"-space")

	adminID := newUser(t, pool, "Admin")
	leavingID := newUser(t, pool, "Leaving")
	stayingID := newUser(t, pool, "Staying")
	bystanderID := newUser(t, pool, "Bystander")
	joinOrg(t, pool, orgID, adminID, "admin")
	for _, id := range []string{leavingID, stayingID, bystanderID} {
		joinOrg(t, pool, orgID, id, "member")
	}
	now := time.Now().UTC()
	joinSpace(t, pool, spaceID, leavingID, "owner", now)
	joinSpace(t, pool, spaceID, stayingID, "owner", now.Add(-time.Hour))
	// The bystander is the most recently seen member in the space, so a
	// promotion that ran at all would pick them.
	joinSpace(t, pool, spaceID, bystanderID, "member", now)

	store := &Store{Pool: pool}
	if _, blocked, err := store.RevokeOrgMember(ctx, Scope{OrgID: orgID, OrgSlug: orgSlug, ActorID: adminID}, leavingID); err != nil {
		t.Fatalf("revoke: %v (blocked %v)", err, blocked)
	}

	owners := spaceOwners(t, pool, spaceID)
	if len(owners) != 1 || owners[0] != stayingID {
		t.Fatalf("the space is owned by %v, want just the surviving owner %s — a space with two owners needs no successor",
			owners, stayingID)
	}
	var role string
	if err := pool.QueryRow(ctx,
		"select role from members where space_id = $1 and user_id = $2", spaceID, bystanderID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != roleMember {
		t.Fatalf("the bystander came out of somebody else's revoke as %q — nobody chose them as an owner", role)
	}
}
