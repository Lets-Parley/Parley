package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
)

func TestEmbedHandoffBindsAndRedeemsOnce(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	h := &EmbedHandoffs{Users: &Users{Pool: pool}}
	ada, _ := newUser(t, pool, "Ada")
	bob, _ := newUser(t, pool, "Bob")
	// Random, because this package's tests share one database across runs.
	verifier, _ := NewToken()
	challenge := sha256.Sum256([]byte(verifier))

	if _, err := h.Create(ctx, challenge[:], "meet", "198.51.100.7"); err != nil {
		t.Fatal(err)
	}
	other, _ := NewToken()
	wrong := sha256.Sum256([]byte(other))
	_, hash := NewToken()
	if _, err := h.Redeem(ctx, wrong[:], hash); !errors.Is(err, ErrNoHandoff) {
		t.Fatalf("redeem with the wrong verifier's challenge: %v, want ErrNoHandoff", err)
	}
	if _, err := h.Redeem(ctx, challenge[:], hash); !errors.Is(err, ErrHandoffPending) {
		t.Fatalf("redeem before bind: %v, want ErrHandoffPending", err)
	}
	if _, err := h.Bind(ctx, challenge[:], ada.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Bind(ctx, challenge[:], bob.ID); !errors.Is(err, ErrNoHandoff) {
		t.Fatalf("a second bind: %v, want ErrNoHandoff", err)
	}
	userID, err := h.Redeem(ctx, challenge[:], hash)
	if err != nil || userID != ada.ID {
		t.Fatalf("redeem: %q %v, want %q", userID, err, ada.ID)
	}
	sess, err := h.Users.ResolveToken(ctx, hash, false)
	if err != nil || !sess.Embedded || sess.User.ID != ada.ID {
		t.Fatalf("the minted token: %+v %v, want an embedded session for Ada", sess, err)
	}
	_, again := NewToken()
	if _, err := h.Redeem(ctx, challenge[:], again); !errors.Is(err, ErrNoHandoff) {
		t.Fatalf("a second redeem: %v, want ErrNoHandoff", err)
	}
}

// TestRenameKeepsAnEmbeddedTokenEmbedded: rotating a token must not launder an
// embedded session into a full-power one. The api refuses renaming to an
// embedded session; this is the statement's own lock behind that.
func TestRenameKeepsAnEmbeddedTokenEmbedded(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	h := &EmbedHandoffs{Users: &Users{Pool: pool}}
	ada, _ := newUser(t, pool, "Ada")
	verifier, _ := NewToken()
	challenge := sha256.Sum256([]byte(verifier))
	if _, err := h.Create(ctx, challenge[:], "meet", "198.51.100.8"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Bind(ctx, challenge[:], ada.ID); err != nil {
		t.Fatal(err)
	}
	_, old := NewToken()
	if _, err := h.Redeem(ctx, challenge[:], old); err != nil {
		t.Fatal(err)
	}
	before, err := h.Users.ResolveToken(ctx, old, false)
	if err != nil {
		t.Fatal(err)
	}
	_, rotated := NewToken()
	if _, err := h.Users.Rename(ctx, ada.ID, "Ada Two", old, rotated); err != nil {
		t.Fatal(err)
	}
	after, err := h.Users.ResolveToken(ctx, rotated, false)
	if err != nil {
		t.Fatal(err)
	}
	if !after.Embedded {
		t.Errorf("the rotated token is not embedded: a rename turned a meeting-client session into a full one")
	}
	if after.ExpiresAt.After(before.ExpiresAt) {
		t.Errorf("the rotated token expires at %v, later than the embedded one it replaced (%v)", after.ExpiresAt, before.ExpiresAt)
	}
}
