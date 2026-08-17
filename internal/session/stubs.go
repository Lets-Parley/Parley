package session

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/store"
)

// Placeholder registration so the session lifecycle runs end-to-end; the
// standup package replaces this with a real state builder and config.
func init() {
	Register("standup",
		func(_ context.Context, _ *pgxpool.Pool, _ store.Session) (any, error) {
			return map[string]any{}, nil
		},
		func() any { return &struct{}{} })
}
