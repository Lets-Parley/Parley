// Package principal carries the resolved request identity through context,
// shared by the api core and feature packages without import cycles.
package principal

import "context"

type Principal struct {
	UserID  string
	Display string
}

type ctxKey struct{}

func With(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

func From(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
