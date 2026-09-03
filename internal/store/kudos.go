package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrNoKudo is a kudo that is not there, or is not the caller's to delete.
	// The two are one error on purpose: telling a stranger that a kudo exists
	// but belongs to somebody else is a fact they had no way to learn.
	ErrNoKudo = errors.New("no such kudo")
	// ErrSelfKudo is thanking yourself.
	ErrSelfKudo = errors.New("a kudo cannot be sent to yourself")
	// ErrNotAMember is a recipient who is not on the space's roster — an
	// outsider, or a link guest, who holds a users row but no members row.
	ErrNotAMember = errors.New("the recipient is not a member of this space")
)

// Kudo is a note from one member of a space to another. There is deliberately
// no count anywhere near this type: see 0033_kudos.sql.
type Kudo struct {
	ID         string    `json:"id"`
	FromUserID string    `json:"fromUserId"`
	ToUserID   string    `json:"toUserId"`
	Text       string    `json:"text"`
	SessionID  string    `json:"sessionId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

type Kudos struct {
	Pool *pgxpool.Pool
}

const kudoCols = "id, from_user_id, to_user_id, text, session_id, created_at"

func scanKudo(row pgx.Row) (Kudo, error) {
	var k Kudo
	var session *string
	err := row.Scan(&k.ID, &k.FromUserID, &k.ToUserID, &k.Text, &session, &k.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) || isMalformedUUID(err) {
		return Kudo{}, ErrNoKudo
	}
	if session != nil {
		k.SessionID = *session
	}
	return k, err
}

// Create records one kudo. The recipient's membership and the space's cap are
// checked inside the insert's own transaction, behind a lock on the space row —
// the shape Decks.Create uses — so racing sends cannot both pass the cap, and a
// recipient cannot be waved through by leaving the space mid-insert.
//
// sessionID may be empty, for a kudo given outside a room.
func (s *Kudos) Create(ctx context.Context, spaceID, fromUserID, toUserID, text, sessionID string, limit int) (Kudo, error) {
	if fromUserID == toUserID {
		return Kudo{}, ErrSelfKudo
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Kudo{}, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "select id from spaces where id = $1 for update", spaceID); err != nil {
		return Kudo{}, fmt.Errorf("locking the space: %w", err)
	}
	var member bool
	if err := tx.QueryRow(ctx,
		"select exists (select 1 from members where space_id = $1 and user_id = $2)",
		spaceID, toUserID).Scan(&member); err != nil {
		if isMalformedUUID(err) {
			return Kudo{}, ErrNotAMember
		}
		return Kudo{}, fmt.Errorf("checking the recipient's membership: %w", err)
	}
	if !member {
		return Kudo{}, ErrNotAMember
	}
	var count int
	if err := tx.QueryRow(ctx, "select count(*) from kudos where space_id = $1", spaceID).Scan(&count); err != nil {
		return Kudo{}, fmt.Errorf("counting a space's kudos: %w", err)
	}
	if count >= limit {
		return Kudo{}, ErrQuotaExceeded
	}

	// Empty means "not given in a room": the column is nullable, and an empty
	// string is not a uuid.
	var session any
	if sessionID != "" {
		session = sessionID
	}
	k, err := scanKudo(tx.QueryRow(ctx,
		"insert into kudos (space_id, from_user_id, to_user_id, text, session_id) values ($1, $2, $3, $4, $5) returning "+kudoCols,
		spaceID, fromUserID, toUserID, text, session))
	if err != nil {
		return Kudo{}, err
	}
	return k, tx.Commit(ctx)
}

// ListForSpace returns a space's kudos, newest first, at most a hundred. There
// is no cursor: decks, members, sessions and commitments are all returned
// whole, and paging is the org directory's problem, not a space's.
func (s *Kudos) ListForSpace(ctx context.Context, spaceID string) ([]Kudo, error) {
	rows, err := s.Pool.Query(ctx,
		"select "+kudoCols+" from kudos where space_id = $1 order by created_at desc, id desc limit 100", spaceID)
	if err != nil {
		return nil, fmt.Errorf("listing kudos: %w", err)
	}
	defer rows.Close()
	kudos := []Kudo{}
	for rows.Next() {
		k, err := scanKudo(rows)
		if err != nil {
			return nil, fmt.Errorf("reading a kudo: %w", err)
		}
		kudos = append(kudos, k)
	}
	return kudos, rows.Err()
}

// Delete removes a kudo the sender sent. Nobody else can — not the recipient,
// not a space owner — and a refused delete is ErrNoKudo, never a silent
// success.
func (s *Kudos) Delete(ctx context.Context, id, senderID string) error {
	tag, err := s.Pool.Exec(ctx, "delete from kudos where id = $1 and from_user_id = $2", id, senderID)
	if isMalformedUUID(err) {
		return ErrNoKudo
	}
	if err != nil {
		return fmt.Errorf("deleting a kudo: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoKudo
	}
	return nil
}
