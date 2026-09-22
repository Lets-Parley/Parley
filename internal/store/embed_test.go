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
