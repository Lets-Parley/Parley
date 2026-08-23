package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
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
	// AvatarIcon is an opaque client-side id; empty means the person has not
	// chosen one and the derived hue stands alone.
	AvatarIcon string `json:"avatarIcon"`
	// LinkSessionID names the one room a link-bound identity may take part in,
	// and is empty for every ordinary account. It is the room, not the link:
	// authorization is always asked about a session.
	LinkSessionID string `json:"-"`
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

// chargeIdentityBuckets spends one unit of both hourly identity budgets, or
// reports that this client has none left. Every path that mints a users row
// from an unauthenticated request goes through it: open-mode signup and link
// redemption alike, because one leaked link is otherwise an unbounded
// user-row factory.
func chargeIdentityBuckets(ctx context.Context, tx pgx.Tx, clientAddress string, perClientLimit, globalLimit int) error {
	var bucket time.Time
	var retryAfter int
	if err := tx.QueryRow(ctx, `
		select date_trunc('hour', now()),
		       greatest(1, ceil(extract(epoch from date_trunc('hour', now()) + interval '1 hour' - now())))::integer`,
	).Scan(&bucket, &retryAfter); err != nil {
		return err
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
		return &IdentityRateLimitError{RetryAfter: retryAfter}
	} else if err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `
		insert into identity_creation_global_buckets (bucket_start, count)
		values ($1, 1)
		on conflict (bucket_start) do update
		set count = identity_creation_global_buckets.count + 1
		where identity_creation_global_buckets.count < $2
		returning count`, bucket, globalLimit).Scan(&count); errors.Is(err, pgx.ErrNoRows) {
		return &IdentityRateLimitError{RetryAfter: retryAfter}
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "delete from identity_creation_buckets where bucket_start < $1::timestamptz - interval '1 hour'", bucket); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "delete from identity_creation_global_buckets where bucket_start < $1::timestamptz - interval '1 hour'", bucket)
	return err
}

func (s *Users) CreateOpen(ctx context.Context, name string, tokenHash []byte, clientAddress string, perClientLimit, globalLimit int) (User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)

	if err := chargeIdentityBuckets(ctx, tx, clientAddress, perClientLimit, globalLimit); err != nil {
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
		returning id, name, avatar_icon`,
		name, issuer, subject,
	).Scan(&u.ID, &u.Name, &u.AvatarIcon); err != nil {
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
	sess, err := s.ResolveToken(ctx, tokenHash, true)
	return sess.User, err
}

// linkSessionExpr resolves a token's user to the one room its link binds it
// to, or the empty string for every ordinary account. It is written as a
// subquery rather than a join so ResolveToken stays a single-row lookup.
const linkSessionExpr = `coalesce((select l.session_id::text from session_links l
	          where l.id = (select link_id from users where id = user_id)), '')`

// tokenExpiryExpr is the earlier of the rolling idle window and the token's own
// absolute expiry, which only a redeemed link sets. Null means no absolute
// expiry, so the idle window stands alone.
const tokenExpiryExpr = `least(last_used_at + $2::interval, coalesce(expires_at, 'infinity'::timestamptz))`

// tokenLiveClause is the whole definition of a usable token, and both
// ResolveToken and TokenExpiry must apply it: an absolute expiry that only one
// of them honoured would leave a lapsed link either answering requests or
// holding a socket.
const tokenLiveClause = `token_hash = $1 and last_used_at > now() - $2::interval
		  and (expires_at is null or expires_at > now())`

const resolveTokenColumns = `user_id,
	          (select name from users where id = user_id),
	          (select issuer from users where id = user_id),
	          (select avatar_icon from users where id = user_id),
	          ` + linkSessionExpr + `,
	          ` + tokenExpiryExpr

// ResolveToken resolves a valid token and returns the resulting idle expiry so
// long-lived transports can enforce the same session lifetime.
//
// touch says whether resolving counts as user activity and so renews the idle
// window. It must be false for a request the CSRF guard waves through: that
// guard exempts GET on the grounds that a GET changes nothing, so a touching
// GET would hand any third-party page a way to renew a victim's idle window
// forever with one <img src> per visit — and to drive unbounded writes against
// session_tokens. A read-only resolve still refuses an already-expired token,
// so nothing about expiry or revocation is relaxed; only the renewal is
// withheld.
func (s *Users) ResolveToken(ctx context.Context, tokenHash []byte, touch bool) (TokenSession, error) {
	sql := `select ` + resolveTokenColumns + `
		from session_tokens
		where ` + tokenLiveClause
	if touch {
		sql = `update session_tokens set last_used_at = now()
		where ` + tokenLiveClause + `
		returning ` + resolveTokenColumns
	}

	var u User
	var expiresAt time.Time
	err := s.Pool.QueryRow(ctx, sql, tokenHash, tokenIdleExpiry).
		Scan(&u.ID, &u.Name, &u.Issuer, &u.AvatarIcon, &u.LinkSessionID, &expiresAt)
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
		select `+tokenExpiryExpr+`
		from session_tokens
		where `+tokenLiveClause,
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
		"update users set name = $2 where id = $1 returning id, name, avatar_icon",
		userID, name,
	).Scan(&u.ID, &u.Name, &u.AvatarIcon); err != nil {
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

// SetAvatar stores the chosen icon and reports whether the row actually
// changed, so a caller can skip the work a no-op write would trigger. The id
// is validated at the API boundary; this only bounds its length, which the
// column check enforces anyway.
//
// avatar_accessory is deliberately absent: accessories were removed with the
// portrait tier, and the column is left in place, unwritten and unread, until
// a migration drops it.
func (s *Users) SetAvatar(ctx context.Context, userID, icon string) (bool, error) {
	tag, err := s.Pool.Exec(ctx, `
		update users set avatar_icon = $2
		where id = $1 and avatar_icon is distinct from $2`,
		userID, icon)
	if err != nil {
		return false, fmt.Errorf("setting avatar: %w", err)
	}
	return tag.RowsAffected() > 0, nil
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

// CreateForLink mints the ordinary users row behind a redeemed link, flagged
// link-bound, and opens a session for it whose token dies with the link. It
// spends the same hourly identity budget an open-mode signup does: without
// that, one leaked link is an unbounded user-row factory.
//
// The redemption count is incremented under the same conditional predicate
// ByToken reads, inside this transaction, so concurrent redemptions of the
// last remaining slot cannot both win.
func (s *Users) CreateForLink(ctx context.Context, name, linkID string, tokenHash []byte, expiresAt time.Time, redemptionCap int, clientAddress string, perClientLimit, globalLimit int) (User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)

	if err := chargeIdentityBuckets(ctx, tx, clientAddress, perClientLimit, globalLimit); err != nil {
		return User{}, err
	}

	tag, err := tx.Exec(ctx, `
		update session_links set redemptions = redemptions + 1
		where id = $1 and revoked_at is null and expires_at > now() and redemptions < $2`,
		linkID, redemptionCap)
	if err != nil {
		return User{}, fmt.Errorf("counting a link redemption: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return User{}, ErrNoLink
	}

	var u User
	if err := tx.QueryRow(ctx,
		"insert into users (name, link_id) values ($1, $2) returning id, name, avatar_icon",
		name, linkID,
	).Scan(&u.ID, &u.Name, &u.AvatarIcon); err != nil {
		return User{}, fmt.Errorf("creating a link identity: %w", err)
	}
	if _, err := tx.Exec(ctx,
		"insert into session_tokens (token_hash, user_id, expires_at) values ($1, $2, $3)",
		tokenHash, u.ID, expiresAt); err != nil {
		return User{}, fmt.Errorf("opening a link session: %w", err)
	}
	return u, tx.Commit(ctx)
}
