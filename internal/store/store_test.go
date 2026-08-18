package store

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/db"
)

// testPool hands back a migrated pool, or skips when no database is
// configured. Migrate is idempotent, so calling it here costs nothing on a
// database another package already prepared.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(context.Background(), pool, slog.New(slog.NewTextHandler(os.Stderr, nil))); err != nil {
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

// newSpace creates a space with a slug unique to the calling test.
func newSpace(t *testing.T, pool *pgxpool.Pool) Space {
	t.Helper()
	slug := Slugify(t.Name()) + "-" + randSuffix(t)
	sp, err := (&Spaces{Pool: pool}).Create(context.Background(), t.Name(), slug, "")
	if err != nil {
		t.Fatal(err)
	}
	return sp
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
	// 64 chars of "a" then a space then more: the cut lands on the separator,
	// which must not survive into the slug.
	got := Slugify(strings.Repeat("a", 64) + " tail")
	if len(got) > 64 {
		t.Fatalf("slug is %d chars, want <= 64", len(got))
	}
	if got[len(got)-1] == '-' {
		t.Fatalf("slug %q ends in a dash", got)
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
	if _, err := spaces.Create(ctx, "Other name", sp.Slug, ""); err != ErrSlugTaken {
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

	sp := newSpace(t, pool)
	u, _ := newUser(t, pool, "Nina Kowalski")

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
	if len(roster) != 1 {
		t.Fatalf("roster has %d entries after three joins, want 1", len(roster))
	}
}

func TestRosterIsOrderedByName(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	ctx := context.Background()

	sp := newSpace(t, pool)
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
	want := []string{"Ben Alvarez", "Priya Raman", "Tomas Herrera"}
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
	if got, _ := spaces.BySlug(ctx, sp.Slug); got.Passcode != "" {
		t.Fatalf("passcode = %q after clearing, want empty", got.Passcode)
	}
}
