// Package principal carries the resolved request identity through context,
// shared by the api core and feature packages without import cycles.
package principal

import (
	"context"
	"time"
)

type Principal struct {
	UserID         string
	Display        string
	TokenID        string
	TokenExpiresAt time.Time
	// The chosen avatar, carried from the row resolvePrincipal already reads
	// so /api/me answers from the principal without a second query.
	AvatarIcon string
	// LinkSessionID names the one room this identity may take part in, and is
	// empty for every ordinary account. A non-empty value is a capability, not
	// a membership: it grants participate-only access to that room and nothing
	// anywhere else, so every authorization check must ask about it explicitly.
	LinkSessionID string
}

// IsLinkGuest reports whether this identity came from a redeemed signed link.
func (p Principal) IsLinkGuest() bool { return p.LinkSessionID != "" }

type ctxKey struct{}

func With(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

func From(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
