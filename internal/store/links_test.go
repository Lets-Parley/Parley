package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// newLink mints a link on the session with the given lifetime and returns the
// stored row alongside the plain token, which is never readable again.
func newLink(t *testing.T, links *Links, sessionID, createdBy string, lifetime time.Duration) (SessionLink, string) {
	t.Helper()
	plain, hash := NewToken()
	link, err := links.Create(context.Background(), sessionID, createdBy, hash, time.Now().Add(lifetime), 10)
	if err != nil {
		t.Fatal(err)
	}
	return link, plain
}

func TestLinkByTokenResolvesALiveLink(t *testing.T) {
	pool := testPool(t)
	sess, members := newSession(t, pool, "Fay")
	links := &Links{Pool: pool}

	link, plain := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	hash, err := HashToken(plain)
	if err != nil {
		t.Fatal(err)
	}
	got, err := links.ByToken(context.Background(), hash, LinkRedemptionCap)
	if err != nil {
		t.Fatalf("ByToken: %v", err)
	}
	if got.ID != link.ID || got.SessionID != sess.ID {
		t.Fatalf("ByToken = %+v, want link %s on session %s", got, link.ID, sess.ID)
	}
}

func TestLinkByTokenRefusesExpiredRevokedAndExhausted(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, members := newSession(t, pool, "Fay")
	links := &Links{Pool: pool}

	_, expiredToken := newLink(t, links, sess.ID, members[0].ID, -time.Minute)
	revoked, revokedToken := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	if _, err := links.Revoke(ctx, sess.ID, revoked.ID); err != nil {
		t.Fatal(err)
	}
	exhausted, exhaustedToken := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	if _, err := pool.Exec(ctx, "update session_links set redemptions = $2 where id = $1", exhausted.ID, 3); err != nil {
		t.Fatal(err)
	}

	for name, plain := range map[string]string{
		"expired":   expiredToken,
		"revoked":   revokedToken,
		"exhausted": exhaustedToken,
	} {
		hash, err := HashToken(plain)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := links.ByToken(ctx, hash, 3); !errors.Is(err, ErrNoLink) {
			t.Errorf("ByToken(%s) = %v, want ErrNoLink", name, err)
		}
	}
}

func TestLinkRevokeIsIdempotentAndScopedToItsSession(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, members := newSession(t, pool, "Fay")
	other, otherMembers := newSession(t, pool, "Ola")
	links := &Links{Pool: pool}

	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	if _, err := links.Revoke(ctx, sess.ID, link.ID); err != nil {
		t.Fatalf("first revoke: %v", err)
	}
	if _, err := links.Revoke(ctx, sess.ID, link.ID); err != nil {
		t.Fatalf("second revoke: %v", err)
	}
	// A link belonging to another room must not be revocable through this one,
	// and the mismatch must not read as a successful no-op either.
	foreign, _ := newLink(t, links, other.ID, otherMembers[0].ID, LinkLifetime)
	if _, err := links.Revoke(ctx, sess.ID, foreign.ID); !errors.Is(err, ErrNoLink) {
		t.Fatalf("cross-session revoke = %v, want ErrNoLink", err)
	}
}

func TestLinkCreateHoldsThePerSessionCap(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, members := newSession(t, pool, "Fay")
	links := &Links{Pool: pool}

	first, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	_, hash := NewToken()
	if _, err := links.Create(ctx, sess.ID, members[0].ID, hash, time.Now().Add(LinkLifetime), 1); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("over-cap Create = %v, want ErrQuotaExceeded", err)
	}
	// Revoking frees the slot: the cap counts live links, not the whole
	// history, which is never deleted.
	if _, err := links.Revoke(ctx, sess.ID, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := links.Create(ctx, sess.ID, members[0].ID, hash, time.Now().Add(LinkLifetime), 1); err != nil {
		t.Fatalf("Create after revoke: %v", err)
	}
}

func TestLinkListForSessionCarriesNoToken(t *testing.T) {
	pool := testPool(t)
	sess, members := newSession(t, pool, "Fay")
	links := &Links{Pool: pool}

	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	got, err := links.ListForSession(context.Background(), sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != link.ID {
		t.Fatalf("ListForSession = %+v, want one link %s", got, link.ID)
	}
	if got[0].Redemptions != 0 || got[0].RevokedAt != nil {
		t.Fatalf("fresh link listed as %+v", got[0])
	}
}

// A deleted link must not take its holders' contributions with it. Everything
// hanging off users cascades, so users.link_id has to be `on delete set null`.
func TestDeletingALinkKeepsItsUsersAndTheirVotes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, members := newSession(t, pool, "Fay")
	links := &Links{Pool: pool}

	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	guest, _ := newUser(t, pool, "Guest")
	if _, err := pool.Exec(ctx, "update users set link_id = $2 where id = $1", guest.ID, link.ID); err != nil {
		t.Fatal(err)
	}
	var storyID string
	if err := pool.QueryRow(ctx,
		"insert into stories (session_id, title, position) values ($1, 'Story', 1) returning id", sess.ID,
	).Scan(&storyID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"insert into votes (story_id, user_id, value) values ($1, $2, '5')", storyID, guest.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(ctx, "delete from session_links where id = $1", link.ID); err != nil {
		t.Fatalf("deleting the link: %v", err)
	}

	var linkID *string
	if err := pool.QueryRow(ctx, "select link_id from users where id = $1", guest.ID).Scan(&linkID); err != nil {
		t.Fatalf("the guest did not survive their link: %v", err)
	}
	if linkID != nil {
		t.Fatalf("link_id = %v, want null", *linkID)
	}
	var votes int
	if err := pool.QueryRow(ctx, "select count(*) from votes where user_id = $1", guest.ID).Scan(&votes); err != nil {
		t.Fatal(err)
	}
	if votes != 1 {
		t.Fatalf("votes = %d, want 1", votes)
	}
}

// The middleware refuses a link guest the claim route outright; this is the
// second lock, on the statement itself. Seizing an idle room is the escalation
// a signed link most obviously invites, so neither guard stands alone.
func TestClaimFacilitatorRefusesALinkBoundUser(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Fay", "Mel")
	links := &Links{Pool: pool}
	users := &Users{Pool: pool}

	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	_, guestToken := NewToken()
	guest, err := users.CreateForLink(ctx, "Gus", link.ID, guestToken, link.ExpiresAt, LinkRedemptionCap, "10.0.0.1", 10, 500)
	if err != nil {
		t.Fatal(err)
	}
	staleFacilitator(t, pool, sess.ID)

	sessions := &Sessions{Pool: pool}
	if err := sessions.ClaimFacilitator(ctx, sess.ID, guest.ID); !errors.Is(err, ErrNotEligible) {
		t.Fatalf("link guest claim: got %v, want ErrNotEligible", err)
	}
	// The same claim from an ordinary member still succeeds, so the predicate
	// excludes link-bound users and nothing else.
	if err := sessions.ClaimFacilitator(ctx, sess.ID, members[1].ID); err != nil {
		t.Fatalf("member claim: %v", err)
	}
}

// Revoking a link closes the sessions it opened: the token rows go, so
// hub.DisconnectToken has something to sever and revalidation cannot bring
// them back. The people and their votes stay.
func TestRevokeClosesTheLinkSessionsItOpened(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Fay")
	links := &Links{Pool: pool}
	users := &Users{Pool: pool}

	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	_, tokenHash := NewToken()
	guest, err := users.CreateForLink(ctx, "Gus", link.ID, tokenHash, link.ExpiresAt, LinkRedemptionCap, "10.0.0.2", 10, 500)
	if err != nil {
		t.Fatal(err)
	}

	revoked, err := links.Revoke(ctx, sess.ID, link.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revoked) != 1 || string(revoked[0]) != string(tokenHash) {
		t.Fatalf("revoke returned %d token digests, want the guest's one", len(revoked))
	}
	if _, err := users.ResolveToken(ctx, tokenHash, false); !errors.Is(err, ErrNoUser) {
		t.Fatalf("revoked link token still resolves: %v", err)
	}
	var alive bool
	if err := pool.QueryRow(ctx, "select exists (select 1 from users where id = $1)", guest.ID).Scan(&alive); err != nil {
		t.Fatal(err)
	}
	if !alive {
		t.Fatal("revoking a link deleted the guest it had minted")
	}
}

// TestIsLinkGuestOfIgnoresDeadLinks keeps the membership hook fail-closed on
// its own terms. The hub happens to check the token's expiry first today, but
// a predicate that only knew about revocation would make this answer depend on
// two tables staying in step.
func TestIsLinkGuestOfIgnoresDeadLinks(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	sess, members := newSession(t, pool, "Fay")
	links := &Links{Pool: pool}
	users := &Users{Pool: pool}

	live, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	expired, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	revoked, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)

	guests := map[string]string{}
	for name, link := range map[string]SessionLink{"live": live, "expired": expired, "revoked": revoked} {
		_, hash := NewToken()
		u, err := users.CreateForLink(ctx, "Gus", link.ID, hash, link.ExpiresAt, LinkRedemptionCap, "10.0.0.3", 10, 500)
		if err != nil {
			t.Fatal(err)
		}
		guests[name] = u.ID
	}
	// Redemption is what mints the guest, so both links are killed afterwards
	// — exactly as they die under a guest who is already connected.
	if _, err := pool.Exec(ctx,
		"update session_links set expires_at = now() - interval '1 minute' where id = $1", expired.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := links.Revoke(ctx, sess.ID, revoked.ID); err != nil {
		t.Fatal(err)
	}

	for name, want := range map[string]bool{"live": true, "expired": false, "revoked": false} {
		got, err := users.IsLinkGuestOf(ctx, guests[name], sess.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("IsLinkGuestOf for the %s link = %v, want %v", name, got, want)
		}
	}
}
