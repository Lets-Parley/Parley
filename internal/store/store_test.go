package store

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"

	"github.com/lets-parley/parley/internal/db"
)

// testPool hands back a migrated pool, or skips when no database is
// configured. Migrate is idempotent, so calling it here costs nothing on a
// database another package already prepared.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := dbtest.DSN(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(context.Background(), pool, slog.New(slog.NewTextHandler(os.Stderr, nil)), db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	return pool
}

// newUser creates a user plus a fresh session token and returns both.
func newUser(t *testing.T, pool *pgxpool.Pool, name string) (User, string) {
	t.Helper()
	plain, hash := NewToken()
	u, err := (&Users{Pool: pool}).Create(context.Background(), name, hash)
	if err != nil {
		t.Fatal(err)
	}
	return u, plain
}

// newSpace creates a space with a slug unique to the calling test. Spaces.Create
// enrols the creator, so the space comes back with one member already on the
// roster; newSpaceWithCreator is for tests that need to name them.
func newSpace(t *testing.T, pool *pgxpool.Pool) Space {
	t.Helper()
	sp, _ := newSpaceWithCreator(t, pool)
	return sp
}

func newSpaceWithCreator(t *testing.T, pool *pgxpool.Pool) (Space, User) {
	t.Helper()
	// The slug column caps at 64 characters, so the readable prefix is bounded
	// to leave room for the suffix: a long test name must not fail as an
	// opaque constraint violation.
	prefix := Slugify(t.Name())
	if len(prefix) > 40 {
		prefix = strings.Trim(prefix[:40], "-")
	}
	slug := prefix + "-" + randSuffix(t)
	creator, _ := newUser(t, pool, "Creator "+randSuffix(t))
	sp, err := (&Spaces{Pool: pool}).Create(context.Background(), t.Name(), slug, "", creator.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	return sp, creator
}

// randSuffix keeps slugs unique across reruns against the same database.
func randSuffix(t *testing.T) string {
	t.Helper()
	s, _ := NewToken()
	return Slugify(s[:10])
}

func TestSlugify(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Platform Team", "platform-team"},
		{"  Spaced  Out  ", "spaced-out"},
		{"UPPER", "upper"},
		{"a/b?c", "a-b-c"},
		{"---leading and trailing---", "leading-and-trailing"},
		{"emoji 🚀 team", "emoji-team"},
		{"!!!", ""},
		{"", ""},
	} {
		if got := Slugify(tc.in); got != tc.want {
			t.Errorf("Slugify(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSlugifyTruncatesWithoutTrailingDash(t *testing.T) {
	// 63 characters then a separator: the 64-character cut lands exactly on
	// the dash, which must be trimmed rather than stored. The slug CHECK
	// constraint requires an alphanumeric at both ends, so leaving it there
	// turns a long space name into a constraint violation on insert.
	got := Slugify(strings.Repeat("a", 63) + " tail")
	if want := strings.Repeat("a", 63); got != want {
		t.Fatalf("Slugify = %q, want %q", got, want)
	}
}

func TestAvatarHueIsStableAndInRange(t *testing.T) {
	const id = "4f1b6b6e-0000-4000-8000-000000000000"
	first := AvatarHue(id)
	if first != AvatarHue(id) {
		t.Fatal("AvatarHue is not stable for the same id")
	}
	for _, u := range []string{id, "", "another-id", "🙂"} {
		if h := AvatarHue(u); h < 0 || h > 359 {
			t.Errorf("AvatarHue(%q) = %d, want 0..359", u, h)
		}
	}
}

func TestTokenRoundTrip(t *testing.T) {
	plain, hash := NewToken()
	got, err := HashToken(plain)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(hash) {
		t.Fatal("HashToken(plain) does not match the hash NewToken returned")
	}
	if len(hash) != 32 {
		t.Fatalf("hash is %d bytes, want 32", len(hash))
	}

	other, _ := NewToken()
	if other == plain {
		t.Fatal("NewToken returned the same token twice")
	}
	if _, err := HashToken("not base64!!"); err == nil {
		t.Fatal("HashToken accepted a malformed token")
	}
}

func TestByTokenResolvesAndRejects(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool}
	ctx := context.Background()

	u, plain := newUser(t, pool, "Dana")
	hash, _ := HashToken(plain)

	got, err := users.ByToken(ctx, hash)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != u.ID || got.Name != "Dana" {
		t.Fatalf("ByToken = %+v, want %+v", got, u)
	}
	if got.Issuer != "" {
		t.Fatalf("anonymous user has issuer %q, want empty", got.Issuer)
	}

	if _, err := users.ByToken(ctx, []byte("thirty-two-bytes-of-wrong-hash!!")); err != ErrNoUser {
		t.Fatalf("unknown token: got %v, want ErrNoUser", err)
	}
}

func TestByTokenRefusesIdleExpiredToken(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool}
	ctx := context.Background()

	_, plain := newUser(t, pool, "Idle")
	hash, _ := HashToken(plain)

	// Backdate past the idle window. This is the only way to exercise the
	// expiry clause without waiting 90 days.
	if _, err := pool.Exec(ctx,
		"update session_tokens set last_used_at = now() - interval '91 days' where token_hash = $1",
		hash); err != nil {
		t.Fatal(err)
	}
	if _, err := users.ByToken(ctx, hash); err != ErrNoUser {
		t.Fatalf("expired token: got %v, want ErrNoUser", err)
	}
}

func TestRenameRotatesTheToken(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool}
	ctx := context.Background()

	u, oldPlain := newUser(t, pool, "Before")
	oldHash, _ := HashToken(oldPlain)
	newPlain, newHash := NewToken()

	renamed, err := users.Rename(ctx, u.ID, "After", oldHash, newHash)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != "After" {
		t.Fatalf("name = %q, want After", renamed.Name)
	}
	if _, err := users.ByToken(ctx, oldHash); err != ErrNoUser {
		t.Fatalf("old token still works: %v", err)
	}
	h, _ := HashToken(newPlain)
	got, err := users.ByToken(ctx, h)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != u.ID || got.Name != "After" {
		t.Fatalf("new token resolved to %+v, want %s/After", got, u.ID)
	}
}

func TestUpsertFederatedIsOneUserPerSubject(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool}
	ctx := context.Background()

	issuer := "https://idp.example/" + randSuffix(t)
	_, h1 := NewToken()
	first, err := users.UpsertFederated(ctx, issuer, "sub-1", "Marcus O", h1)
	if err != nil {
		t.Fatal(err)
	}

	// Same subject, new name: the same user, renamed from the provider.
	_, h2 := NewToken()
	second, err := users.UpsertFederated(ctx, issuer, "sub-1", "Marcus Okonjo", h2)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Fatalf("second sign-in created a new user %s (first %s)", second.ID, first.ID)
	}
	if second.Name != "Marcus Okonjo" {
		t.Fatalf("name = %q, want the refreshed name from the provider", second.Name)
	}

	// Both tokens are live: signing in on a second device must not evict the first.
	for i, h := range [][]byte{h1, h2} {
		u, err := users.ByToken(ctx, h)
		if err != nil {
			t.Fatalf("token %d: %v", i, err)
		}
		if u.Issuer != issuer {
			t.Fatalf("token %d: issuer = %q, want %q", i, u.Issuer, issuer)
		}
	}

	// A different subject at the same issuer is a different person.
	_, h3 := NewToken()
	other, err := users.UpsertFederated(ctx, issuer, "sub-2", "Priya Raman", h3)
	if err != nil {
		t.Fatal(err)
	}
	if other.ID == first.ID {
		t.Fatal("a different subject collapsed onto the same user")
	}
}

func TestSpaceCreateRejectsDuplicateSlug(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	ctx := context.Background()

	sp := newSpace(t, pool)
	creator, _ := newUser(t, pool, "Duplicate Slug Creator")
	if _, err := spaces.Create(ctx, "Other name", sp.Slug, "", creator.ID, 50); err != ErrSlugTaken {
		t.Fatalf("duplicate slug: got %v, want ErrSlugTaken", err)
	}
	if _, err := spaces.BySlug(ctx, "no-such-space-"+randSuffix(t)); err != ErrNoSpace {
		t.Fatalf("missing slug: got %v, want ErrNoSpace", err)
	}
}

func TestJoinIsIdempotent(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	ctx := context.Background()

	sp, creator := newSpaceWithCreator(t, pool)
	u, _ := newUser(t, pool, "Nina Kowalski")

	if ok, err := spaces.IsMember(ctx, sp.ID, creator.ID); err != nil || !ok {
		t.Fatalf("IsMember(creator) = %v, %v; want true, nil — Create enrols the creator", ok, err)
	}
	if ok, err := spaces.IsMember(ctx, sp.ID, u.ID); err != nil || ok {
		t.Fatalf("IsMember before join = %v, %v; want false, nil", ok, err)
	}
	for i := 0; i < 3; i++ {
		if err := spaces.Join(ctx, sp.ID, u.ID); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}
	if ok, err := spaces.IsMember(ctx, sp.ID, u.ID); err != nil || !ok {
		t.Fatalf("IsMember after join = %v, %v; want true, nil", ok, err)
	}
	roster, err := spaces.Roster(ctx, sp.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The creator plus the one joiner: three joins must still add exactly one.
	if len(roster) != 2 {
		t.Fatalf("roster has %d entries after three joins, want 2 (creator + joiner)", len(roster))
	}
}

func TestRosterIsOrderedByName(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	ctx := context.Background()

	sp, creator := newSpaceWithCreator(t, pool)
	// Joined out of order on purpose: the roster is what the standup speaking
	// order is built from, so the sort must come from the query, not insertion.
	for _, name := range []string{"Tomas Herrera", "Ben Alvarez", "Priya Raman"} {
		u, _ := newUser(t, pool, name)
		if err := spaces.Join(ctx, sp.ID, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	roster, err := spaces.Roster(ctx, sp.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, m := range roster {
		got = append(got, m.Name)
	}
	// The creator is enrolled by Create and named "Creator <suffix>", so it
	// sorts between Ben and Priya wherever the suffix lands.
	want := []string{"Ben Alvarez", creator.Name, "Priya Raman", "Tomas Herrera"}
	if len(got) != len(want) {
		t.Fatalf("roster = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("roster = %v, want %v", got, want)
		}
	}
}

func TestSetPasscode(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	ctx := context.Background()

	sp := newSpace(t, pool)
	if err := spaces.SetPasscode(ctx, sp.ID, "TEAM49"); err != nil {
		t.Fatal(err)
	}
	got, err := spaces.BySlug(ctx, sp.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if got.Passcode != "TEAM49" {
		t.Fatalf("passcode = %q, want TEAM49", got.Passcode)
	}
	if err := spaces.SetPasscode(ctx, sp.ID, ""); err != nil {
		t.Fatal(err)
	}
	cleared, err := spaces.BySlug(ctx, sp.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Passcode != "" {
		t.Fatalf("passcode = %q after clearing, want empty", cleared.Passcode)
	}
}

// The RowsAffected guards on Rename and Delete are only reachable through a
// race — the HTTP layer resolves the space first, so a nonexistent id never
// gets that far — which is exactly why they need a test that skips the
// handler and calls the store directly. Without one they are dead code that
// the whole API suite passes without.
func TestSpaceRenameAndDeleteReportAVanishedSpace(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	gone := "00000000-0000-0000-0000-000000000000"

	if err := spaces.Rename(context.Background(), gone, "Nope"); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("rename of a space that is not there: got %v, want ErrNoSpace", err)
	}
	if err := spaces.Delete(context.Background(), gone); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("delete of a space that is not there: got %v, want ErrNoSpace", err)
	}
}

// The version bump is what a client reconnecting after a rename compares
// against to know its cached title is stale. Everyone already holding a socket
// gets the new title from the broadcast regardless, so nothing in the API
// suite notices if the bump goes missing.
func TestSessionRenameBumpsTheVersion(t *testing.T) {
	pool := testPool(t)
	sp, creator := newSpaceWithCreator(t, pool)
	sessions := &Sessions{Pool: pool}

	sess, err := sessions.Create(context.Background(), sp.ID, "poker", "Sprint 1", []byte(`{}`), creator.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	before, err := sessions.ByID(context.Background(), sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.Rename(context.Background(), sess.ID, sp.ID, "Sprint 2"); err != nil {
		t.Fatal(err)
	}
	after, err := sessions.ByID(context.Background(), sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version+1 {
		t.Fatalf("version after rename: got %d, want %d", after.Version, before.Version+1)
	}
	if after.Title != "Sprint 2" {
		t.Fatalf("title after rename: got %q", after.Title)
	}

	// And the same guard on the delete path, for a session that is not there.
	if err := sessions.Delete(context.Background(), sess.ID, "00000000-0000-0000-0000-000000000000"); !errors.Is(err, ErrNoSession) {
		t.Fatalf("delete scoped to the wrong space: got %v, want ErrNoSession", err)
	}
}
