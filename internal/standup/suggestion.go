package standup

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// YesterdaySuggestion reads the author's prior text without creating an entry.
// An existing entry, even one with a blank Yesterday, takes precedence.
func YesterdaySuggestion(ctx context.Context, pool *pgxpool.Pool, sess store.Session, userID string) (string, error) {
	var text string
	err := pool.QueryRow(ctx, `
		select `+yesterdayPrefill+`
		from (select $3::uuid as user_id) m
		where not exists (
			select 1 from standup_entries where session_id = $1 and user_id = m.user_id
		)`, sess.ID, sess.SpaceID, userID, sess.CreatedAt).Scan(&text)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("reading yesterday suggestion: %w", err)
	}
	return text, nil
}
