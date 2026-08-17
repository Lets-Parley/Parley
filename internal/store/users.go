package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tokens idle longer than this are invalid and eligible for deletion.
const tokenIdleExpiry = 90 * 24 * time.Hour

var ErrNoUser = errors.New("no user for token")

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Users struct {
	Pool *pgxpool.Pool
}

func NewToken() (plain string, hash []byte) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	sum := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(raw), sum[:]
}

func HashToken(plain string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(plain)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	return sum[:], nil
}

func (s *Users) Create(ctx context.Context, name string, tokenHash []byte) (User, error) {
	var u User
	err := s.Pool.QueryRow(ctx,
		"insert into users (name) values ($1) returning id, name", name,
	).Scan(&u.ID, &u.Name)
	if err != nil {
		return User{}, err
	}
	_, err = s.Pool.Exec(ctx,
		"insert into session_tokens (token_hash, user_id) values ($1, $2)", tokenHash, u.ID)
	return u, err
}

// ByToken resolves a token hash to its user, refusing idle-expired tokens and
// touching last_used_at so active sessions never expire.
func (s *Users) ByToken(ctx context.Context, tokenHash []byte) (User, error) {
	var u User
	err := s.Pool.QueryRow(ctx, `
		update session_tokens set last_used_at = now()
		where token_hash = $1 and last_used_at > now() - $2::interval
		returning user_id, (select name from users where id = user_id)`,
		tokenHash, tokenIdleExpiry,
	).Scan(&u.ID, &u.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNoUser
	}
	return u, err
}

// Rename updates the user's name and rotates their token: the old token row is
// replaced by newTokenHash in one transaction.
func (s *Users) Rename(ctx context.Context, userID, name string, oldTokenHash, newTokenHash []byte) (User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)

	var u User
	if err := tx.QueryRow(ctx,
		"update users set name = $2 where id = $1 returning id, name", userID, name,
	).Scan(&u.ID, &u.Name); err != nil {
		return User{}, err
	}
	if _, err := tx.Exec(ctx,
		"delete from session_tokens where token_hash = $1", oldTokenHash); err != nil {
		return User{}, err
	}
	if _, err := tx.Exec(ctx,
		"insert into session_tokens (token_hash, user_id) values ($1, $2)", newTokenHash, u.ID); err != nil {
		return User{}, err
	}
	return u, tx.Commit(ctx)
}

func (s *Users) DeleteToken(ctx context.Context, tokenHash []byte) error {
	_, err := s.Pool.Exec(ctx, "delete from session_tokens where token_hash = $1", tokenHash)
	return err
}
