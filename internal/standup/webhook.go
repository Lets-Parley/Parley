package standup

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/recovery"
)

// WebhookMaxAttempts bounds delivery: after this many failed attempts an
// event is given up on and recorded as failed.
const WebhookMaxAttempts = 5

// webhookLookback bounds how far back the sweep looks for events. It keeps
// every pass cheap; an instance down for longer than this drops the events
// that fell out of the window rather than delivering a day-old backlog.
const webhookLookback = "1 day"

// webhookPayload is the whole of what leaves the instance: which event,
// which space, where the room is, and the event id. No entry, blocker or
// participant text is ever part of it.
type webhookPayload struct {
	Event      string       `json:"event"`
	ID         string       `json:"id"`
	SessionURL string       `json:"sessionUrl"`
	Space      webhookSpace `json:"space"`
}

type webhookSpace struct {
	Org  string `json:"org"`
	Slug string `json:"slug"`
}

// SignWebhook is the X-Parley-Signature value for body: HMAC-SHA256 keyed by
// the space's secret, hex encoded, prefixed "sha256=".
func SignWebhook(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Webhooks is a space's standup webhook configuration and its durable,
// at-least-once delivery. Every replica may run it at once.
type Webhooks struct {
	Pool *pgxpool.Pool
	// BaseURL is the instance's public origin, for the session URL.
	BaseURL string
	// Seal and Open encrypt the signing secret at rest.
	Seal func(plaintext string) (nonce, ciphertext []byte, err error)
	Open func(nonce, ciphertext []byte) (string, error)
	// Send posts one delivery. In production it goes through the plugin
	// fetch guard; it returns the response status.
	Send func(ctx context.Context, url string, headers map[string]string, body []byte) (int, error)
}

// Get returns the space's webhook URL, or ok false when it has none. The
// secret is never read back out.
func (w *Webhooks) Get(ctx context.Context, spaceID string) (string, bool, error) {
	var u string
	err := w.Pool.QueryRow(ctx, "select url from standup_webhooks where space_id = $1", spaceID).Scan(&u)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("reading standup webhook: %w", err)
	}
	return u, true, nil
}

// Put creates or replaces the space's webhook with a new secret. Replacing
// keeps created_at, so it does not replay the events since then.
func (w *Webhooks) Put(ctx context.Context, spaceID, userID, url, secret string) error {
	nonce, sealed, err := w.Seal(secret)
	if err != nil {
		return fmt.Errorf("sealing the webhook secret: %w", err)
	}
	_, err = w.Pool.Exec(ctx, `
		insert into standup_webhooks (space_id, url, secret_nonce, secret_ciphertext, updated_by)
		values ($1, $2, $3, $4, nullif($5, '')::uuid)
		on conflict (space_id) do update set
			url = excluded.url, secret_nonce = excluded.secret_nonce,
			secret_ciphertext = excluded.secret_ciphertext, updated_by = excluded.updated_by`,
		spaceID, url, nonce, sealed, userID)
	if err != nil {
		return fmt.Errorf("saving standup webhook: %w", err)
	}
	return nil
}

// Delete removes the space's webhook. Undelivered events fail on their next
// attempt rather than going to a URL the owner has removed.
func (w *Webhooks) Delete(ctx context.Context, spaceID string) error {
	if _, err := w.Pool.Exec(ctx, "delete from standup_webhooks where space_id = $1", spaceID); err != nil {
		return fmt.Errorf("deleting standup webhook: %w", err)
	}
	return nil
}

// Enqueue records every standup event that has happened in a space with a
// webhook since it was configured. It is a sweep rather than a hook on each
// code path that opens or ends a room, so no path can forget it; the unique
// (session_id, event) key makes it idempotent on every replica at once.
func (w *Webhooks) Enqueue(ctx context.Context) error {
	_, err := w.Pool.Exec(ctx, `
		insert into standup_webhook_deliveries (space_id, session_id, event)
		select s.space_id, s.id, e.event
		from sessions s
		join standup_webhooks h on h.space_id = s.space_id
		cross join lateral (values
			('standup.opened', s.created_at),
			('standup.closed', case
				when s.config->>'mode' = 'async' and s.config ? 'closesAt'
				 and (s.ended_at is null or s.ended_at > (s.config->>'closesAt')::timestamptz)
				then (s.config->>'closesAt')::timestamptz end),
			('standup.ended', s.ended_at)
		) as e(event, at)
		where s.kind = 'standup'
		  and e.at is not null
		  and e.at <= now()
		  and e.at >= h.created_at
		  and e.at > now() - interval '`+webhookLookback+`'
		on conflict (session_id, event) do nothing`)
	if err != nil {
		return fmt.Errorf("enqueueing standup webhook events: %w", err)
	}
	return nil
}

type claimedDelivery struct {
	id, event, sessionID, spaceID string
	attempts                      int
}

// Deliver sends every due event once. A claim takes a lease as well as the
// row lock, because the lock is released at commit and without the lease a
// second replica would pick up a row that is still being sent.
func (w *Webhooks) Deliver(ctx context.Context) error {
	rows, err := w.Pool.Query(ctx, `
		update standup_webhook_deliveries d
		set lease_until = now() + interval '2 minutes', attempts = attempts + 1
		where d.id in (
			select id from standup_webhook_deliveries
			where delivered_at is null and failed_at is null and next_attempt_at <= now()
			  and (lease_until is null or lease_until < now())
			order by next_attempt_at
			limit 20
			for update skip locked)
		returning d.id::text, d.event, d.session_id::text, d.space_id::text, d.attempts`)
	if err != nil {
		return fmt.Errorf("claiming standup webhook deliveries: %w", err)
	}
	var due []claimedDelivery
	for rows.Next() {
		var c claimedDelivery
		if err := rows.Scan(&c.id, &c.event, &c.sessionID, &c.spaceID, &c.attempts); err != nil {
			rows.Close()
			return fmt.Errorf("reading standup webhook delivery: %w", err)
		}
		due = append(due, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("claiming standup webhook deliveries: %w", err)
	}
	for _, c := range due {
		if err := w.deliverOne(ctx, c); err != nil {
			return err
		}
	}
	return nil
}

func (w *Webhooks) deliverOne(ctx context.Context, c claimedDelivery) error {
	var url, org, slug string
	var nonce, sealed []byte
	err := w.Pool.QueryRow(ctx, `
		select h.url, h.secret_nonce, h.secret_ciphertext, o.slug, sp.slug
		from standup_webhooks h
		join spaces sp on sp.id = h.space_id
		join orgs o on o.id = sp.org_id
		where h.space_id = $1`, c.spaceID).Scan(&url, &nonce, &sealed, &org, &slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return w.finish(ctx, c, false, "the webhook was removed", true)
	}
	if err != nil {
		return fmt.Errorf("reading standup webhook: %w", err)
	}
	secret, err := w.Open(nonce, sealed)
	if err != nil {
		return w.finish(ctx, c, false, "the signing secret could not be decrypted", true)
	}
	body, err := json.Marshal(webhookPayload{
		Event:      c.event,
		ID:         c.id,
		SessionURL: w.BaseURL + "/session/" + c.sessionID,
		Space:      webhookSpace{Org: org, Slug: slug},
	})
	if err != nil {
		return err
	}
	status, sendErr := w.Send(ctx, url, map[string]string{
		"Content-Type":       "application/json",
		"User-Agent":         "Parley-Webhook",
		"X-Parley-Event":     c.event,
		"X-Parley-Event-Id":  c.id,
		"X-Parley-Signature": SignWebhook(secret, body),
	}, body)
	switch {
	case sendErr != nil:
		return w.finish(ctx, c, false, sendErr.Error(), false)
	case status < 200 || status > 299:
		return w.finish(ctx, c, false, fmt.Sprintf("the receiver answered %d", status), false)
	}
	return w.finish(ctx, c, true, "", false)
}

// finish records one attempt. A failure is retried after 30s, 2m, 8m and
// 32m, and given up on at WebhookMaxAttempts or when it can never succeed.
func (w *Webhooks) finish(ctx context.Context, c claimedDelivery, ok bool, reason string, permanent bool) error {
	var err error
	switch {
	case ok:
		_, err = w.Pool.Exec(ctx,
			"update standup_webhook_deliveries set delivered_at = now(), lease_until = null, last_error = null where id = $1", c.id)
	case permanent || c.attempts >= WebhookMaxAttempts:
		slog.Warn("standup webhook delivery gave up", "event_id", c.id, "event", c.event, "attempts", c.attempts)
		_, err = w.Pool.Exec(ctx,
			"update standup_webhook_deliveries set failed_at = now(), lease_until = null, last_error = $2 where id = $1", c.id, reason)
	default:
		backoff := 30 * time.Second << (2 * (c.attempts - 1))
		_, err = w.Pool.Exec(ctx,
			"update standup_webhook_deliveries set next_attempt_at = now() + make_interval(secs => $2), lease_until = null, last_error = $3 where id = $1",
			c.id, backoff.Seconds(), reason)
	}
	if err != nil {
		return fmt.Errorf("recording standup webhook delivery: %w", err)
	}
	return nil
}

// Run sweeps and delivers every interval until ctx is done. The
// caller owns the goroutine and waits for it before the pool closes.
func (w *Webhooks) Run(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		w.pass(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (w *Webhooks) pass(ctx context.Context) {
	defer recovery.Handle("standup webhooks")
	if err := w.Enqueue(ctx); err != nil && ctx.Err() == nil {
		slog.Error("standup webhook sweep failed", "error", err)
	}
	if err := w.Deliver(ctx); err != nil && ctx.Err() == nil {
		slog.Error("standup webhook delivery failed", "error", err)
	}
}
