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

var (
	ErrNoDeck        = errors.New("no such deck")
	ErrDeckNameTaken = errors.New("deck name taken")
)

// Deck is a card template owned by a space. It is never joined to at vote
// time: a session copies the cards it was created with into its own config.
type Deck struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Cards     []string  `json:"cards"`
	Ordinal   bool      `json:"ordinal"`
	CreatedAt time.Time `json:"createdAt"`
}

type Decks struct {
	Pool *pgxpool.Pool
}

const deckCols = "id, name, cards, ordinal, created_at"

func scanDeck(row pgx.Row) (Deck, error) {
	var d Deck
	err := row.Scan(&d.ID, &d.Name, &d.Cards, &d.Ordinal, &d.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) || isMalformedUUID(err) {
		return Deck{}, ErrNoDeck
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return Deck{}, ErrDeckNameTaken
	}
	return d, err
}

// isMalformedUUID is true for the error Postgres raises when an id from the URL
// is not a uuid at all. A junk id is a lookup that found nothing, not a server
// fault, so it has to reach the caller as ErrNoDeck rather than a 500.
func isMalformedUUID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}

// ForSpace lists one space's decks, oldest first.
func (s *Decks) ForSpace(ctx context.Context, spaceID string) ([]Deck, error) {
	rows, err := s.Pool.Query(ctx, "select "+deckCols+" from decks where space_id = $1 order by created_at, id", spaceID)
	if err != nil {
		return nil, fmt.Errorf("listing decks: %w", err)
	}
	defer rows.Close()
	decks := []Deck{}
	for rows.Next() {
		d, err := scanDeck(rows)
		if err != nil {
			return nil, fmt.Errorf("reading deck: %w", err)
		}
		decks = append(decks, d)
	}
	return decks, rows.Err()
}

// Create adds a deck under the space's own cap. The count and the insert share
// one transaction behind a lock on the space row, the same shape session
// creation uses, so racing creates cannot both pass the cap.
func (s *Decks) Create(ctx context.Context, spaceID, name string, cards []string, ordinal bool, limit int) (Deck, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Deck{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "select id from spaces where id = $1 for update", spaceID); err != nil {
		return Deck{}, err
	}
	var count int
	if err := tx.QueryRow(ctx, "select count(*) from decks where space_id = $1", spaceID).Scan(&count); err != nil {
		return Deck{}, err
	}
	if count >= limit {
		return Deck{}, ErrQuotaExceeded
	}
	d, err := scanDeck(tx.QueryRow(ctx,
		"insert into decks (space_id, name, cards, ordinal) values ($1, $2, $3, $4) returning "+deckCols,
		spaceID, name, cards, ordinal))
	if err != nil {
		return Deck{}, err
	}
	return d, tx.Commit(ctx)
}

// Update rewrites a deck. The space id is part of the WHERE clause, not just
// the caller's permission check: without it an owner of one space could edit a
// deck belonging to another by id alone.
func (s *Decks) Update(ctx context.Context, spaceID, id, name string, cards []string, ordinal bool) (Deck, error) {
	return scanDeck(s.Pool.QueryRow(ctx,
		"update decks set name = $3, cards = $4, ordinal = $5 where space_id = $1 and id = $2 returning "+deckCols,
		spaceID, id, name, cards, ordinal))
}

// Delete removes a deck, scoped by space for the same reason Update is. The
// sessions created from it keep their cards: they copied them.
func (s *Decks) Delete(ctx context.Context, spaceID, id string) error {
	tag, err := s.Pool.Exec(ctx, "delete from decks where space_id = $1 and id = $2", spaceID, id)
	if isMalformedUUID(err) {
		return ErrNoDeck
	}
	if err != nil {
		return fmt.Errorf("deleting deck: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoDeck
	}
	return nil
}
