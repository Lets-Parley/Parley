package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"hash/fnv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tokens idle longer than this are invalid and eligible for deletion.
const tokenIdleExpiry = 90 * 24 * time.Hour

var ErrNoUser = errors.New("no user for token")

var ErrIdentityRateLimited = errors.New("identity creation rate limited")

type IdentityRateLimitError struct {
	RetryAfter int
}

func (e *IdentityRateLimitError) Error() string { return ErrIdentityRateLimited.Error() }
func (e *IdentityRateLimitError) Unwrap() error { return ErrIdentityRateLimited }

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Issuer is empty for an anonymous account and names the identity provider
	// for a federated one.
	Issuer string `json:"-"`
}

type Users struct {
	Pool *pgxpool.Pool
}

type TokenSession struct {
	User      User
	ExpiresAt time.Time
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

func (s *Users) CreateOpen(ctx context.Context, name string, tokenHash []byte, clientAddress string, perClientLimit, globalLimit int) (User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)

	var bucket time.Time
	var retryAfter int
	if err := tx.QueryRow(ctx, `
		select date_trunc('hour', now()),
		       greatest(1, ceil(extract(epoch from date_trunc('hour', now()) + interval '1 hour' - now())))::integer`,
	).Scan(&bucket, &retryAfter); err != nil {
		return User{}, err
	}
	digest := sha256.Sum256([]byte(clientAddress))
	var count int
	if err := tx.QueryRow(ctx, `
		insert into identity_creation_buckets (bucket_start, client_digest, count)
		values ($1, $2, 1)
		on conflict (bucket_start, client_digest) do update
		set count = identity_creation_buckets.count + 1
		where identity_creation_buckets.count < $3
		returning count`, bucket, digest[:], perClientLimit).Scan(&count); errors.Is(err, pgx.ErrNoRows) {
		return User{}, &IdentityRateLimitError{RetryAfter: retryAfter}
	} else if err != nil {
		return User{}, err
	}
	if err := tx.QueryRow(ctx, `
		insert into identity_creation_global_buckets (bucket_start, count)
		values ($1, 1)
		on conflict (bucket_start) do update
		set count = identity_creation_global_buckets.count + 1
		where identity_creation_global_buckets.count < $2
		returning count`, bucket, globalLimit).Scan(&count); errors.Is(err, pgx.ErrNoRows) {
		return User{}, &IdentityRateLimitError{RetryAfter: retryAfter}
	} else if err != nil {
		return User{}, err
	}

	var u User
	if err := tx.QueryRow(ctx,
		"insert into users (name) values ($1) returning id, name", name,
	).Scan(&u.ID, &u.Name); err != nil {
		return User{}, err
	}
	if _, err := tx.Exec(ctx,
		"insert into session_tokens (token_hash, user_id) values ($1, $2)", tokenHash, u.ID); err != nil {
		return User{}, err
	}
	if _, err := tx.Exec(ctx, "delete from identity_creation_buckets where bucket_start < $1::timestamptz - interval '1 hour'", bucket); err != nil {
		return User{}, err
	}
	if _, err := tx.Exec(ctx, "delete from identity_creation_global_buckets where bucket_start < $1::timestamptz - interval '1 hour'", bucket); err != nil {
		return User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, err
	}
	return u, nil
}

// UpsertFederated finds or creates the user behind an (issuer, subject) pair and
// opens a session for them. The name is refreshed from the provider on every
// sign-in: the IdP owns it in this mode, so a rename there follows the person
// here rather than leaving a stale label on the roster.
func (s *Users) UpsertFederated(ctx context.Context, issuer, subject, name string, tokenHash []byte) (User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)

	var u User
	// The conflict target is the partial index, so this can only ever match
	// another federated row — never an anonymous one.
	if err := tx.QueryRow(ctx, `
		insert into users (name, issuer, subject) values ($1, $2, $3)
		on conflict (issuer, subject) where issuer <> ''
		do update set name = excluded.name
		returning id, name`,
		name, issuer, subject,
	).Scan(&u.ID, &u.Name); err != nil {
		return User{}, err
	}
	if _, err := tx.Exec(ctx,
		"insert into session_tokens (token_hash, user_id) values ($1, $2)", tokenHash, u.ID); err != nil {
		return User{}, err
	}
	return u, tx.Commit(ctx)
}

// ByToken resolves a token hash to its user, refusing idle-expired tokens and
// touching last_used_at so active sessions never expire.
func (s *Users) ByToken(ctx context.Context, tokenHash []byte) (User, error) {
	sess, err := s.ResolveToken(ctx, tokenHash)
	return sess.User, err
}

// ResolveToken resolves and refreshes a valid token and returns the resulting
// idle expiry so long-lived transports can enforce the same session lifetime.
func (s *Users) ResolveToken(ctx context.Context, tokenHash []byte) (TokenSession, error) {
	var u User
	var expiresAt time.Time
	err := s.Pool.QueryRow(ctx, `
		update session_tokens set last_used_at = now()
		where token_hash = $1 and last_used_at > now() - $2::interval
		returning user_id,
		          (select name from users where id = user_id),
		          (select issuer from users where id = user_id),
		          last_used_at + $2::interval`,
		tokenHash, tokenIdleExpiry,
	).Scan(&u.ID, &u.Name, &u.Issuer, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return TokenSession{}, ErrNoUser
	}
	return TokenSession{User: u, ExpiresAt: expiresAt}, err
}

// TokenExpiry checks shared-store validity without counting the check itself as
// user activity. HTTP requests refresh the idle window; an idle WebSocket does
// not keep its own session alive indefinitely.
func (s *Users) TokenExpiry(ctx context.Context, tokenHash []byte) (time.Time, error) {
	var expiresAt time.Time
	err := s.Pool.QueryRow(ctx, `
		select last_used_at + $2::interval
		from session_tokens
		where token_hash = $1 and last_used_at > now() - $2::interval`,
		tokenHash, tokenIdleExpiry,
	).Scan(&expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, ErrNoUser
	}
	return expiresAt, err
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

// AvatarHue derives a stable hue (0-359) from a user id; clients render the
// avatar from it so every surface shows the same color per person.
func AvatarHue(userID string) int {
	h := fnv.New32a()
	h.Write([]byte(userID))
	return int(h.Sum32() % 360)
}
