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
	// Subject is the identity-provider subject for a federated account, and
	// empty for an anonymous or link-bound one. Audit logs use AuditSubject
	// rather than this field so those two cases are named "open" and "guest".
	Subject string
}

// IsLinkGuest reports whether this identity came from a redeemed signed link.
func (p Principal) IsLinkGuest() bool { return p.LinkSessionID != "" }

// AuditSubject is the actor_subject field on a security-event line: the IdP
// subject when there is one, otherwise "guest" or "open". It is never an email.
func (p Principal) AuditSubject() string {
	if p.IsLinkGuest() {
		return "guest"
	}
	if p.Subject != "" {
		return p.Subject
	}
	return "open"
}

type clientAddrKey struct{}

// WithClientAddr records the address the rest of the app treats as the client
// (post trusted-proxy rewrite) so a security-event line can name it without
// holding the *http.Request.
func WithClientAddr(ctx context.Context, addr string) context.Context {
	return context.WithValue(ctx, clientAddrKey{}, addr)
}

// ClientAddr returns the address WithClientAddr stored, or "".
func ClientAddr(ctx context.Context) string {
	s, _ := ctx.Value(clientAddrKey{}).(string)
	return s
}

type ctxKey struct{}

func With(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

func From(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
