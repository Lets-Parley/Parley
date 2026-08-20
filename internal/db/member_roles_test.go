package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"
)

// memberRolesVersion is the migration under test. Everything below it is the
// "already deployed" world the upgrade has to land on.
const memberRolesVersion = 15

// upTo copies the shipped migrations with a version at or below max, so a test
// can stand a database up at an older head and then upgrade it for real.
func upTo(t *testing.T, max int) fs.FS {
	t.Helper()
	all, err := loadMigrations(MigrationsFS)
	if err != nil {
		t.Fatal(err)
	}
	fsys := fstest.MapFS{}
	for _, m := range all {
		if m.version > max {
			continue
		}
		data, err := fs.ReadFile(MigrationsFS, "migrations/"+m.name)
		if err != nil {
			t.Fatal(err)
		}
		fsys["migrations/"+m.name] = &fstest.MapFile{Data: data}
	}
	if len(fsys) == 0 {
		t.Fatalf("no migrations at or below version %d", max)
	}
	return fsys
}

// scratchPool creates a throwaway database next to the configured one, so a
// migration can be exercised from an older head without disturbing the shared
// test database every other package migrates to the current one.
func scratchPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	dsn := dbtest.DSN(t)

	raw := make([]byte, 8)
	rand.Read(raw)
	name := "parley_scratch_" + hex.EncodeToString(raw)

	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connecting to create a scratch database: %v", err)
	}
	if _, err := admin.Exec(ctx, "create database "+pgx.Identifier{name}.Sanitize()); err != nil {
		admin.Close(ctx)
		t.Fatalf("creating scratch database: %v", err)
	}
	admin.Close(ctx)

	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parsing the test DSN: %v", err)
	}
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatalf("connecting to the scratch database: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		drop, err := pgx.Connect(context.Background(), dsn)
		if err != nil {
			return
		}
		defer drop.Close(context.Background())
		drop.Exec(context.Background(), "drop database "+pgx.Identifier{name}.Sanitize()+" with (force)")
	})
	return pool
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestMemberRolesBackfillOnUpgrade is the upgrade path: a database already at
// the previous head, with real spaces and members in it, must come out with
// every space owned by somebody. A fresh install gets its owner from
// Spaces.Create; an existing install can only get one from this backfill.
func TestMemberRolesBackfillOnUpgrade(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)
	log := quietLogger()

	if err := Migrate(ctx, pool, log, upTo(t, memberRolesVersion-1)); err != nil {
		t.Fatalf("migrating to the previous head: %v", err)
	}

	var creator, joiner, orphanA, orphanB string
	for _, u := range []struct {
		name string
		into *string
	}{{"Ada", &creator}, {"Bob", &joiner}, {"Cleo", &orphanA}, {"Dev", &orphanB}} {
		if err := pool.QueryRow(ctx, "insert into users (name) values ($1) returning id", u.name).Scan(u.into); err != nil {
			t.Fatal(err)
		}
	}

	// A space made after creator_id existed: its creator is the obvious owner.
	var owned string
	if err := pool.QueryRow(ctx,
		"insert into spaces (slug, name, creator_id) values ('backfill-owned', 'Owned', $1) returning id", creator,
	).Scan(&owned); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2), ($1, $3)", owned, creator, joiner); err != nil {
		t.Fatal(err)
	}

	// A space from before creator_id was added — nullable to this day, so an
	// upgrade that only looks at creator_id leaves it permanently ownerless
	// and therefore permanently unmanageable.
	var orphaned string
	if err := pool.QueryRow(ctx,
		"insert into spaces (slug, name) values ('backfill-orphan', 'Orphan') returning id",
	).Scan(&orphaned); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into members (space_id, user_id, last_seen_at) values
		 ($1, $2, now() - interval '10 days'), ($1, $3, now() - interval '1 day')`,
		orphaned, orphanA, orphanB); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatalf("upgrading with existing rows: %v", err)
	}

	role := func(spaceID, userID string) string {
		t.Helper()
		var r string
		if err := pool.QueryRow(ctx, "select role from members where space_id = $1 and user_id = $2", spaceID, userID).Scan(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	if got := role(owned, creator); got != "owner" {
		t.Errorf("the creator of an existing space is %q, want owner", got)
	}
	if got := role(owned, joiner); got != "member" {
		t.Errorf("an existing joiner is %q, want member", got)
	}
	if got := role(orphaned, orphanA); got != "owner" {
		t.Errorf("the earliest member of a creator-less space is %q, want owner", got)
	}
	if got := role(orphaned, orphanB); got != "member" {
		t.Errorf("a later member of a creator-less space is %q, want member", got)
	}

	// No space may come out of the upgrade with nobody able to manage it.
	var ownerless int
	if err := pool.QueryRow(ctx, `
		select count(*) from spaces s
		where exists (select 1 from members m where m.space_id = s.id)
		  and not exists (select 1 from members m where m.space_id = s.id and m.role = 'owner')`,
	).Scan(&ownerless); err != nil {
		t.Fatal(err)
	}
	if ownerless != 0 {
		t.Errorf("%d space(s) came out of the upgrade with no owner", ownerless)
	}
}

// TestMemberRolesOnAFreshDatabase is the install path: the same migration set
// applied from nothing must produce the same column with the same constraint.
func TestMemberRolesOnAFreshDatabase(t *testing.T) {
	ctx := context.Background()
	pool := scratchPool(t)

	if err := Migrate(ctx, pool, quietLogger(), MigrationsFS); err != nil {
		t.Fatalf("migrating a fresh database: %v", err)
	}

	var dflt string
	var notNull bool
	if err := pool.QueryRow(ctx, `
		select column_default, is_nullable = 'NO'
		from information_schema.columns
		where table_name = 'members' and column_name = 'role'`,
	).Scan(&dflt, &notNull); err != nil {
		t.Fatalf("members.role is missing on a fresh database: %v", err)
	}
	if !notNull {
		t.Error("members.role is nullable")
	}

	var user, space string
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Ada') returning id").Scan(&user); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into spaces (slug, name) values ('fresh', 'Fresh') returning id").Scan(&space); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into members (space_id, user_id, role) values ($1, $2, 'admin')", space, user); err == nil {
		t.Error("members.role accepted 'admin' — the role vocabulary is not constrained in the database")
	}
}
