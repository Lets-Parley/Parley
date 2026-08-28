package db

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestOrgMembersUserActiveIndexExists is the install path: after a full
// migrate the partial user-leading index on active org_members is present.
// Without it every "which orgs is this user in" lookup falls back to a
// sequential scan once the table grows past a few pages.
func TestOrgMembersUserActiveIndexExists(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), MigrationsFS); err != nil {
		t.Fatalf("migrating: %v", err)
	}

	var exists bool
	if err := pool.QueryRow(ctx, `
		select exists (
			select 1 from pg_indexes
			where tablename = 'org_members'
			  and indexname = 'org_members_user_active_idx'
		)`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("expected org_members_user_active_idx after migrate")
	}

	var def string
	if err := pool.QueryRow(ctx, `
		select indexdef from pg_indexes
		where indexname = 'org_members_user_active_idx'`).Scan(&def); err != nil {
		t.Fatal(err)
	}
	lower := strings.ToLower(def)
	// pg_indexes renders btree indexes as "USING btree (cols) WHERE …".
	// Require user_id alone as the leading (and only) key — an (org_id,
	// user_id) composite still contains "user_id" but cannot serve
	// user-leading lookups without org_id.
	if !strings.Contains(lower, "using btree (user_id) where") {
		t.Fatalf("index must be btree on (user_id) alone; got %s", def)
	}
	if !strings.Contains(lower, "revoked_at is null") {
		t.Fatalf("index must be partial on revoked_at is null; got %s", def)
	}
}

// TestOrgMembersUserActiveIndexServesUserLeadingQueries seeds enough active
// memberships that the planner leaves a sequential scan behind, then checks
// EXPLAIN for the three user-leading shapes: Orgs.ForUser (org switcher and
// landing grouping share it) and Spaces.OrgSlugsForMemberSpaceSlug, plus the
// bare membership probe those both rest on.
func TestOrgMembersUserActiveIndexServesUserLeadingQueries(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	if err := Migrate(ctx, pool, quietLogger(), MigrationsFS); err != nil {
		t.Fatalf("migrating: %v", err)
	}

	const orgs = 40
	const users = 200
	orgIDs := make([]string, orgs)
	for i := range orgIDs {
		slug := fmt.Sprintf("idx-org-%d", i)
		if err := pool.QueryRow(ctx, `
			insert into orgs (slug, name, claim_value)
			values ($1, $2, $3) returning id`,
			slug, slug, slug,
		).Scan(&orgIDs[i]); err != nil {
			t.Fatalf("seeding org %d: %v", i, err)
		}
	}
	userIDs := make([]string, users)
	for i := range userIDs {
		if err := pool.QueryRow(ctx,
			"insert into users (name) values ($1) returning id",
			fmt.Sprintf("idx-user-%d", i),
		).Scan(&userIDs[i]); err != nil {
			t.Fatalf("seeding user %d: %v", i, err)
		}
	}
	// Bulk-load every user into every org → 8_000 active rows. One revoked
	// row sits beside them so the partial predicate is load-bearing.
	if _, err := pool.Exec(ctx, `
		insert into org_members (org_id, user_id, role)
		select o.id, u.id, 'member'
		from orgs o
		cross join users u
		where o.slug like 'idx-org-%' and u.name like 'idx-user-%'
		on conflict do nothing`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		update org_members set revoked_at = now()
		where user_id = $1 and org_id = $2`, userIDs[0], orgIDs[0]); err != nil {
		t.Fatal(err)
	}
	// A real space so OrgSlugsForMemberSpaceSlug has a row to join through;
	// an empty spaces scan would never reach org_members.
	if _, err := pool.Exec(ctx, `
		insert into spaces (slug, name, org_id, creator_id)
		values ('idx-space', 'Index Space', $1, $2)`, orgIDs[1], userIDs[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "analyze org_members"); err != nil {
		t.Fatal(err)
	}

	probe := userIDs[1]
	shapes := []struct {
		name string
		sql  string
	}{
		{
			name: "bare membership probe",
			sql: `
				select org_id from org_members
				where user_id = $1 and revoked_at is null`,
		},
		{
			name: "Orgs.ForUser (switcher + landing)",
			sql: `
				select o.slug, o.name, m.role
				from org_members m join orgs o on o.id = m.org_id
				where m.user_id = $1 and m.revoked_at is null
				order by o.name`,
		},
		{
			// Production OrgSlugsForMemberSpaceSlug starts from spaces and
			// correctly uses org_members_pkey once org_id is known. The same
			// predicates, driven from membership, are what this index covers
			// when the planner leads with the user.
			name: "OrgSlugs predicates (membership-driven)",
			sql: `
				select o.slug
				from org_members om
				join orgs o on o.id = om.org_id
				join spaces sp on sp.org_id = om.org_id and sp.slug = 'idx-space'
				where om.user_id = $1 and om.revoked_at is null
				order by o.slug
				limit 2`,
		},
	}
	for _, shape := range shapes {
		plan := explainText(t, pool, shape.sql, probe)
		if !strings.Contains(plan, "org_members_user_active_idx") {
			t.Fatalf("%s: expected plan to use org_members_user_active_idx;\n%s", shape.name, plan)
		}
	}
}

// explainText runs EXPLAIN inside a transaction with join_collapse_limit = 1
// so the planner keeps the written FROM order. Without that, a selective
// spaces.slug filter reorders OrgSlugs-style joins onto org_members_pkey —
// correct for production, but hides whether the user-leading index can
// serve the same predicates.
func explainText(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "set local join_collapse_limit = 1"); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(ctx, "explain "+sql, args...)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return b.String()
}
