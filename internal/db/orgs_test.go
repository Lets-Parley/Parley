package db

import (
	"context"
	"crypto/sha256"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// orgsVersion is the migration under test. Everything below it is the
// "already deployed" world the upgrade has to land on.
const orgsVersion = 21

// defaultOrgID is the fixed identifier 0021 gives the default org, so
// spaces.org_id can carry it as a literal column default. A subquery is not a
// legal default expression, and the default is what keeps a replica running
// the previous release inserting spaces mid-rollout.
const defaultOrgID = "00000000-0000-0000-0000-000000000001"

// backfillStatement returns the one statement of 0021 that contains match, so
// a test can run the real backfill a second time rather than a paraphrase of
// it that drifts the moment the migration is edited.
func backfillStatement(t *testing.T, match string) string {
	t.Helper()
	data, err := fs.ReadFile(MigrationsFS, "migrations/0021_orgs.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range strings.Split(string(data), ";") {
		if strings.Contains(stmt, match) {
			return stmt
		}
	}
	t.Fatalf("no statement in 0021_orgs.sql contains %q", match)
	return ""
}

// TestOrgsBackfillOnUpgrade is the upgrade path: an existing install must come
// out with every space in the default org, every ordinary user an org member,
// and every link guest left exactly where they were — outside the org.
func TestOrgsBackfillOnUpgrade(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	log := quietLogger()

	if err := Migrate(ctx, pool, log, upTo(t, orgsVersion-1)); err != nil {
		t.Fatalf("migrating to the previous head: %v", err)
	}

	var ordinary string
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Ada') returning id").Scan(&ordinary); err != nil {
		t.Fatal(err)
	}
	var spaceID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (slug, name, creator_id) values ('orgs-upgrade', 'Upgrade', $1) returning id", ordinary,
	).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}

	// The link guest is minted by the real redemption path, not by hand: the
	// exclusion has to keep holding if that path changes shape.
	guest := seedLinkGuest(t, pool, ordinary, spaceID)

	if err := Migrate(ctx, pool, log, upTo(t, orgsVersion)); err != nil {
		t.Fatalf("migrating to the orgs head: %v", err)
	}

	var orgID, visibility string
	if err := pool.QueryRow(ctx, "select org_id, visibility from spaces where id = $1", spaceID).Scan(&orgID, &visibility); err != nil {
		t.Fatal(err)
	}
	if orgID != defaultOrgID {
		t.Errorf("space landed in org %q, want the default org %q", orgID, defaultOrgID)
	}
	if visibility != "private" {
		t.Errorf("space visibility %q, want private so an upgrade discloses exactly what it did yesterday", visibility)
	}

	var members []string
	rows, err := pool.Query(ctx, "select user_id from org_members where org_id = $1", defaultOrgID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		members = append(members, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0] != ordinary {
		t.Fatalf("org_members = %v, want exactly the ordinary user %q (the link guest %q holds a capability, not a membership)", members, ordinary, guest)
	}
}

// TestOrgsBackfillIsIdempotent runs the backfill statement itself against a
// database that already holds a row for the user. Re-running Migrate would
// prove nothing: it skips any version already recorded.
func TestOrgsBackfillIsIdempotent(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), upTo(t, orgsVersion)); err != nil {
		t.Fatalf("migrating: %v", err)
	}

	var user string
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Ada') returning id").Scan(&user); err != nil {
		t.Fatal(err)
	}
	revoked := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	if _, err := pool.Exec(ctx,
		"insert into org_members (org_id, user_id, role, revoked_at) values ($1, $2, 'admin', $3)",
		defaultOrgID, user, revoked); err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(ctx, backfillStatement(t, "insert into org_members")); err != nil {
		t.Fatalf("re-running the backfill: %v", err)
	}

	var count int
	var role string
	var gotRevoked *time.Time
	if err := pool.QueryRow(ctx,
		"select count(*) over (), role, revoked_at from org_members where org_id = $1 and user_id = $2",
		defaultOrgID, user).Scan(&count, &role, &gotRevoked); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("got %d membership rows, want 1", count)
	}
	if role != "admin" {
		t.Errorf("role = %q, want admin left alone", role)
	}
	if gotRevoked == nil || !gotRevoked.UTC().Equal(revoked) {
		t.Errorf("revoked_at = %v, want %v left alone", gotRevoked, revoked)
	}
}

func TestOrgsRejectEmptyClaimValue(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), upTo(t, orgsVersion)); err != nil {
		t.Fatalf("migrating: %v", err)
	}
	_, err := pool.Exec(ctx, "insert into orgs (slug, name, claim_value) values ('empty', 'Empty', '')")
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("empty claim_value was accepted (%v); an empty claim matches every token that lacks it", err)
	}
}

// TestSpacesSlugUniquePerOrg is the point of the composite constraint: a slug
// is a name inside one org, not across the instance.
func TestSpacesSlugUniquePerOrg(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), upTo(t, orgsVersion)); err != nil {
		t.Fatalf("migrating: %v", err)
	}
	var other string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ('other', 'Other', 'other') returning id").Scan(&other); err != nil {
		t.Fatal(err)
	}
	for _, org := range []string{defaultOrgID, other} {
		if _, err := pool.Exec(ctx, "insert into spaces (org_id, slug, name) values ($1, 'shared', 'Shared')", org); err != nil {
			t.Fatalf("inserting the same slug in org %s: %v", org, err)
		}
	}
	_, err := pool.Exec(ctx, "insert into spaces (org_id, slug, name) values ($1, 'shared', 'Shared')", defaultOrgID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("duplicate slug within one org was accepted (%v)", err)
	}
}

// TestSpacesOrgIDKeepsColumnDefault is what a rolling update rides on: a
// replica still running the previous release inserts a space without org_id.
func TestSpacesOrgIDKeepsColumnDefault(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), upTo(t, orgsVersion)); err != nil {
		t.Fatalf("migrating: %v", err)
	}
	var orgID string
	if err := pool.QueryRow(ctx,
		"insert into spaces (slug, name) values ('old-replica', 'Old') returning org_id").Scan(&orgID); err != nil {
		t.Fatalf("an insert without org_id failed, which breaks every replica mid-rollout: %v", err)
	}
	if orgID != defaultOrgID {
		t.Errorf("org_id = %q, want the default org %q", orgID, defaultOrgID)
	}
}

// seedLinkGuest mints a link guest the way the server does — an ordinary
// users row carrying link_id, written by store.Users' redemption path — so the
// backfill's exclusion is asserted against the code that creates these rows
// rather than against a hand-written imitation of it.
func seedLinkGuest(t *testing.T, pool *pgxpool.Pool, creatorID, spaceID string) string {
	t.Helper()
	ctx := context.Background()
	var sessionID string
	if err := pool.QueryRow(ctx,
		"insert into sessions (space_id, kind, title, facilitator_id) values ($1, 'poker', 'Planning', $2) returning id",
		spaceID, creatorID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	links := &store.Links{Pool: pool}
	linkHash := sha256.Sum256([]byte("link-token"))
	link, err := links.Create(ctx, sessionID, creatorID, linkHash[:], time.Now().Add(store.LinkLifetime), 20)
	if err != nil {
		t.Fatal(err)
	}
	users := &store.Users{Pool: pool}
	guestHash := sha256.Sum256([]byte("guest-token"))
	guest, err := users.CreateForLink(ctx, "Guest", link.ID, guestHash[:], time.Now().Add(store.LinkLifetime),
		store.LinkRedemptionCap, "192.0.2.1", 10, 100)
	if err != nil {
		t.Fatal(err)
	}
	var linkID *string
	if err := pool.QueryRow(ctx, "select link_id from users where id = $1", guest.ID).Scan(&linkID); err != nil {
		t.Fatal(err)
	}
	if linkID == nil {
		t.Fatal("the redemption path no longer stamps users.link_id, so the backfill filter no longer identifies link guests")
	}
	return guest.ID
}
