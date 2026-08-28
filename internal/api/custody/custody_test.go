package custody

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
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
