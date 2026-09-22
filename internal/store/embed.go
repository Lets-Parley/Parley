package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// EmbedHandoffTTL is how long a framed page has, from asking, to be bound by a
// signed-in person and to collect its token.
const EmbedHandoffTTL = 5 * time.Minute

// EmbedTokenTTL caps an embedded session from the moment it is minted. It is a
// meeting's worth of access, not an account's.
const EmbedTokenTTL = 12 * time.Hour

var (
	// ErrNoHandoff covers every handoff that cannot be acted on: unknown,
	// expired, already bound (for a bind) or already spent (for a redeem).
	ErrNoHandoff = errors.New("no such embed handoff")
	// ErrHandoffPending is a live handoff nobody has bound yet.
	ErrHandoffPending = errors.New("embed handoff not bound yet")
	// ErrHandoffThrottled is one client asking for too many handoffs.
	ErrHandoffThrottled = errors.New("too many embed handoffs")
)

// embedHandoffsPerClient is how many handoffs one client may open within one
// handoff lifetime. It is count-then-insert, so concurrent requests can
// overshoot by a few; take an advisory lock per client if that ever matters.
const embedHandoffsPerClient = 10

type EmbedHandoff struct {
	Provider    string
	DisplayCode string
}

type EmbedHandoffs struct {
	Users *Users
}

// displayAlphabet omits 0/O and 1/I/L so a code read aloud survives.
const displayAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

func newDisplayCode() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = displayAlphabet[int(b[i])%len(displayAlphabet)]
	}
	return string(b[:3]) + "-" + string(b[3:])
}

// Create opens a handoff for challenge, the S256 digest of a verifier only the
// framed page holds.
func (s *EmbedHandoffs) Create(ctx context.Context, challenge []byte, provider, clientKey string) (EmbedHandoff, error) {
	var recent int
	if err := s.Users.Pool.QueryRow(ctx, `
		select count(*) from embed_handoffs
		where client_key = $1 and created_at > now() - $2::interval`,
		clientKey, EmbedHandoffTTL).Scan(&recent); err != nil {
		return EmbedHandoff{}, fmt.Errorf("counting embed handoffs: %w", err)
	}
	if recent >= embedHandoffsPerClient {
		return EmbedHandoff{}, ErrHandoffThrottled
	}
	h := EmbedHandoff{Provider: provider, DisplayCode: newDisplayCode()}
	// A repeated challenge is a replay, never a second attempt: the verifier
	// behind it is meant to be fresh every time.
	tag, err := s.Users.Pool.Exec(ctx, `
		insert into embed_handoffs (challenge_hash, display_code, provider, client_key, expires_at)
		values ($1, $2, $3, $4, now() + $5::interval)
		on conflict do nothing`,
		challenge, h.DisplayCode, provider, clientKey, EmbedHandoffTTL)
	if err != nil {
		return EmbedHandoff{}, fmt.Errorf("creating an embed handoff: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return EmbedHandoff{}, ErrNoHandoff
	}
	return h, nil
}

// Pending returns a live, unbound handoff: the only state a sign-in page may
// offer to bind.
func (s *EmbedHandoffs) Pending(ctx context.Context, challenge []byte) (EmbedHandoff, error) {
	var h EmbedHandoff
	err := s.Users.Pool.QueryRow(ctx, `
		select provider, display_code from embed_handoffs
		where challenge_hash = $1 and expires_at > now() and bound_at is null`,
		challenge).Scan(&h.Provider, &h.DisplayCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmbedHandoff{}, ErrNoHandoff
	}
	return h, err
}

// Bind hands a live, unbound handoff to userID. It binds once: a second bind,
// by anyone, is ErrNoHandoff.
func (s *EmbedHandoffs) Bind(ctx context.Context, challenge []byte, userID string) (EmbedHandoff, error) {
	var h EmbedHandoff
	err := s.Users.Pool.QueryRow(ctx, `
		update embed_handoffs set user_id = $2, bound_at = now()
		where challenge_hash = $1 and expires_at > now() and bound_at is null
		returning provider, display_code`,
		challenge, userID).Scan(&h.Provider, &h.DisplayCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmbedHandoff{}, ErrNoHandoff
	}
	return h, err
}

// Redeem spends a bound handoff for an embedded session token, once. An
// unbound one is ErrHandoffPending, so the frame keeps polling.
func (s *EmbedHandoffs) Redeem(ctx context.Context, challenge, tokenHash []byte) (string, error) {
	tx, err := s.Users.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var userID *string
	err = tx.QueryRow(ctx, `
		select user_id from embed_handoffs
		where challenge_hash = $1 and expires_at > now() and used_at is null
		for update`, challenge).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNoHandoff
	}
	if err != nil {
		return "", fmt.Errorf("reading an embed handoff: %w", err)
	}
	if userID == nil {
		return "", ErrHandoffPending
	}
	if _, err := tx.Exec(ctx, "update embed_handoffs set used_at = now() where challenge_hash = $1", challenge); err != nil {
		return "", fmt.Errorf("spending an embed handoff: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		insert into session_tokens (token_hash, user_id, expires_at, embedded)
		values ($1, $2, now() + $3::interval, true)`,
		tokenHash, *userID, EmbedTokenTTL); err != nil {
		return "", fmt.Errorf("opening an embedded session: %w", err)
	}
	return *userID, tx.Commit(ctx)
}
