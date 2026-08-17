package session

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/store"
)

// Placeholder registrations so the session lifecycle runs end-to-end; the poker
// and standup packages replace these with real state builders and configs.
func init() {
	Register("poker",
		func(_ context.Context, _ *pgxpool.Pool, _ store.Session) (any, error) {
			return map[string]any{}, nil
		},
		func() any { return &struct{}{} })
	Register("standup",
		func(_ context.Context, _ *pgxpool.Pool, _ store.Session) (any, error) {
			return map[string]any{}, nil
		},
		func() any { return &struct{}{} })
}
