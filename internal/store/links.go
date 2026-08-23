package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// One fixed lifetime and one fixed redemption cap, both server constants.
// There is no per-link chooser: the precedent here is tokenIdleExpiry, and a
// facilitator handing out a link has no better idea of the right number than
// the server does.
const (
	LinkLifetime      = 24 * time.Hour
	LinkRedemptionCap = 25
)

var ErrNoLink = errors.New("no such link")

// SessionLink is a link as anyone but its minter ever sees it: the token is
// absent by construction, so no list response or broadcast state can leak one.
type SessionLink struct {
	ID          string     `json:"id"`
	SessionID   string     `json:"sessionId"`
	CreatedBy   string     `json:"createdBy"`
	ExpiresAt   time.Time  `json:"expiresAt"`
	RevokedAt   *time.Time `json:"revokedAt"`
	Redemptions int        `json:"redemptions"`
	CreatedAt   time.Time  `json:"createdAt"`
}

type Links struct {
	Pool *pgxpool.Pool
}

const linkCols = "id, session_id, created_by, expires_at, revoked_at, redemptions, created_at"

func scanLink(row pgx.Row) (SessionLink, error) {
	var l SessionLink
	err := row.Scan(&l.ID, &l.SessionID, &l.CreatedBy, &l.ExpiresAt, &l.RevokedAt, &l.Redemptions, &l.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionLink{}, ErrNoLink
	}
	return l, err
}

// Create mints a link, refusing once the session already holds limit live
// ones. The cap counts live links rather than the whole history: link rows are
// never deleted, so counting every row a room ever minted would let one
// afternoon exhaust it permanently, and revoking a link would not give the
// slot back.
func (s *Links) Create(ctx context.Context, sessionID, createdBy string, tokenHash []byte, expiresAt time.Time, limit int) (SessionLink, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return SessionLink{}, err
	}
	defer tx.Rollback(ctx)
	// Lock the room so two concurrent mints cannot both read a count one under
	// the cap and both insert.
	if _, err := tx.Exec(ctx, "select id from sessions where id = $1 for update", sessionID); err != nil {
		return SessionLink{}, fmt.Errorf("locking the session: %w", err)
	}
	var count int
	if err := tx.QueryRow(ctx,
		"select count(*) from session_links where session_id = $1 and revoked_at is null and expires_at > now()",
		sessionID).Scan(&count); err != nil {
		return SessionLink{}, fmt.Errorf("counting live links: %w", err)
	}
	if count >= limit {
		return SessionLink{}, ErrQuotaExceeded
	}
	link, err := scanLink(tx.QueryRow(ctx,
		"insert into session_links (session_id, created_by, token_hash, expires_at) values ($1, $2, $3, $4) returning "+linkCols,
		sessionID, createdBy, tokenHash, expiresAt))
	if err != nil {
		return SessionLink{}, fmt.Errorf("creating a session link: %w", err)
	}
	return link, tx.Commit(ctx)
}

// ByToken resolves a token digest to a live link: unrevoked, unexpired and
// still under the redemption cap. Anything else is ErrNoLink — a holder learns
// only that their link does not work, never why.
func (s *Links) ByToken(ctx context.Context, tokenHash []byte, redemptionCap int) (SessionLink, error) {
	return scanLink(s.Pool.QueryRow(ctx,
		"select "+linkCols+" from session_links "+
			"where token_hash = $1 and revoked_at is null and expires_at > now() and redemptions < $2",
		tokenHash, redemptionCap))
}

func (s *Links) ListForSession(ctx context.Context, sessionID string) ([]SessionLink, error) {
	rows, err := s.Pool.Query(ctx,
		"select "+linkCols+" from session_links where session_id = $1 order by created_at desc", sessionID)
	if err != nil {
		return nil, fmt.Errorf("listing session links: %w", err)
	}
	defer rows.Close()
	out := []SessionLink{}
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, fmt.Errorf("scanning a session link: %w", err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// Revoke is idempotent: revoking an already-revoked link succeeds and leaves
// the original revoked_at alone. A link belonging to another room is ErrNoLink
// rather than a silent no-op, so a mistyped id cannot read as success.
func (s *Links) Revoke(ctx context.Context, sessionID, linkID string) error {
	tag, err := s.Pool.Exec(ctx,
		"update session_links set revoked_at = coalesce(revoked_at, now()) where id = $1 and session_id = $2",
		linkID, sessionID)
	// A malformed id is simply not a link here, not a server error.
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
		return ErrNoLink
	}
	if err != nil {
		return fmt.Errorf("revoking a session link: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoLink
	}
	return nil
}
