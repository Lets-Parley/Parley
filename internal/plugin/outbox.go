package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/recovery"
)

// Defaults shared by the outbox and the job queue.
const (
	// DefaultMaxAttempts bounds retries. A delivery that keeps failing goes to
	// the dead-letter state rather than retrying forever in front of live work.
	DefaultMaxAttempts = 8
	// DefaultBaseBackoff is the first retry delay; it doubles per attempt.
	DefaultBaseBackoff = 5 * time.Second
	// DefaultMaxBackoff caps the doubling, so attempt eight is minutes away
	// rather than days.
	DefaultMaxBackoff = 10 * time.Minute
	// DefaultBatch is how many rows one claim takes.
	DefaultBatch = 20
	// DefaultInterval is how often a worker looks for work.
	DefaultInterval = 2 * time.Second
	// DefaultLease is how long a claim hides a row from other claimers.
	// SKIP LOCKED only holds for the length of the claiming transaction, so
	// without a lease a second claimer picks the row up the moment the claim
	// commits and the subscriber sees the same event twice from the claim
	// path. A worker that dies mid-delivery releases the row when the lease
	// expires, which is what keeps delivery at-least-once rather than
	// at-most-once.
	DefaultLease = time.Minute
	// maxErrorLen bounds what a failure writes into last_error. A subscriber
	// that returns its whole response body must not be able to grow the table
	// through the error column.
	maxErrorLen = 500
)

// Delivery is one event owed to one install.
type Delivery struct {
	ID        int64
	EventID   int64
	InstallID string
	Attempts  int
	Topic     string
	Payload   json.RawMessage
}

// Outbox drains plugin_deliveries.
//
// Claims use FOR UPDATE SKIP LOCKED, so running more than one of these — in
// this process or in another replica — is configuration rather than a rewrite,
// even though a single replica needs no leader election today.
type Outbox struct {
	Pool *pgxpool.Pool
	// Deliver hands one delivery to its subscriber. It may be called with the
	// same event more than once; see the package comment on idempotence.
	Deliver func(context.Context, Delivery) error

	MaxAttempts int
	BaseBackoff time.Duration
	Batch       int
	Lease       time.Duration
	Log         *slog.Logger

	noDeliverWarnOnce sync.Once
}

func (o *Outbox) maxAttempts() int { return orDefaultInt(o.MaxAttempts, DefaultMaxAttempts) }
func (o *Outbox) batch() int       { return orDefaultInt(o.Batch, DefaultBatch) }

// Claim takes up to n due deliveries, charges each an attempt, and pushes each
// one out of reach for the lease. The claim is a single statement: two
// concurrent claimers skip each other's locked rows, and the lease keeps the
// row invisible to the loser after the winner's transaction commits.
func (o *Outbox) Claim(ctx context.Context, n int) ([]Delivery, error) {
	rows, err := o.Pool.Query(ctx, `
		with claimed as (
			select id from plugin_deliveries
			where state = 'pending' and available_at <= now()
			order by available_at, id
			limit $1
			for update skip locked
		)
		update plugin_deliveries d
		set attempts = d.attempts + 1, available_at = now() + $2::interval, updated_at = now()
		from claimed c, plugin_events e
		where d.id = c.id and e.id = d.event_id
		returning d.id, d.event_id, d.install_id, d.attempts, e.topic, e.payload`,
		n, orDefaultDuration(o.Lease, DefaultLease).String())
	if err != nil {
		return nil, fmt.Errorf("claiming deliveries: %w", err)
	}
	defer rows.Close()

	var out []Delivery
	for rows.Next() {
		var d Delivery
		var payload []byte
		if err := rows.Scan(&d.ID, &d.EventID, &d.InstallID, &d.Attempts, &d.Topic, &payload); err != nil {
			return nil, fmt.Errorf("reading claimed delivery: %w", err)
		}
		d.Payload = payload
		out = append(out, d)
	}
	return out, rows.Err()
}

// Drain claims a batch, delivers each one, and records the outcome. It returns
// how many deliveries it handled, so a caller can loop until there is nothing
// left.
func (o *Outbox) Drain(ctx context.Context) (int, error) {
	if o.Deliver == nil {
		o.noDeliverWarnOnce.Do(func() {
			if o.Log != nil {
				o.Log.Warn("plugin outbox has no Deliver handler configured; deliveries will accumulate undelivered")
			}
		})
		return 0, nil
	}
	claimed, err := o.Claim(ctx, o.batch())
	if err != nil {
		return 0, err
	}
	for _, d := range claimed {
		err := o.Deliver(ctx, d)
		if err == nil {
			tag, err := o.Pool.Exec(ctx,
				`update plugin_deliveries set state = 'delivered', last_error = null, updated_at = now() where id = $1`,
				d.ID)
			if err != nil {
				return len(claimed), fmt.Errorf("marking delivery %d delivered: %w", d.ID, err)
			}
			// Uninstall is the first thing that can delete a plugin_installs
			// row, and that cascades this delivery away underneath a worker
			// already running it. The UPDATE then affects nothing, and without
			// this the outcome is dropped in silence.
			o.warnVanished(tag.RowsAffected(), d)
			continue
		}
		if err := o.fail(ctx, d, err); err != nil {
			return len(claimed), err
		}
	}
	return len(claimed), nil
}

func (o *Outbox) fail(ctx context.Context, d Delivery, cause error) error {
	state, backoff := settle(d.Attempts, o.maxAttempts(), o.BaseBackoff)
	if _, err := o.Pool.Exec(ctx, `
		update plugin_deliveries
		set state = $2, last_error = $3, available_at = now() + $4::interval, updated_at = now()
		where id = $1`, d.ID, state, truncateError(cause), backoff.String()); err != nil {
		return fmt.Errorf("recording delivery %d failure: %w", d.ID, err)
	}
	if state == "dead" && o.Log != nil {
		o.Log.Warn("plugin delivery dead-lettered after repeated failures",
			"delivery_id", d.ID, "install_id", d.InstallID, "topic", d.Topic,
			"attempts", d.Attempts, "error", cause)
	}
	return nil
}

// Run drains on a ticker until ctx is done.
func (o *Outbox) Run(ctx context.Context, interval time.Duration) {
	runLoop(ctx, interval, o.Log, "plugin outbox", func(ctx context.Context) error {
		_, err := o.Drain(ctx)
		return err
	})
}

// settle decides where a failed attempt leaves a row: dead once it has used up
// its attempts, otherwise pending again after an exponential backoff.
func settle(attempts, maxAttempts int, base time.Duration) (string, time.Duration) {
	if attempts >= maxAttempts {
		return "dead", 0
	}
	if base <= 0 {
		base = DefaultBaseBackoff
	}
	ceiling := max(DefaultMaxBackoff, base)
	backoff := base
	for i := 1; i < attempts && backoff < ceiling; i++ {
		backoff *= 2
	}
	return "pending", min(backoff, ceiling)
}

func truncateError(err error) string {
	msg := err.Error()
	if len(msg) > maxErrorLen {
		return msg[:maxErrorLen]
	}
	return msg
}

func orDefaultDuration(v, fallback time.Duration) time.Duration {
	if v <= 0 {
		return fallback
	}
	return v
}

func orDefaultInt(v, fallback int) int {
	if v <= 0 {
		return fallback
	}
	return v
}

// runLoop is the shared worker shape: drain now, then on every tick, and stop
// on ctx.
func runLoop(ctx context.Context, interval time.Duration, log *slog.Logger, name string, step func(context.Context) error) {
	if interval <= 0 {
		interval = DefaultInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := guardedStep(ctx, name, step); err != nil && ctx.Err() == nil && log != nil {
			log.Error(name+" failed; will retry on the next tick", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// guardedStep contains a panicking pass. runLoop is the retention pass and both
// the outbox and job workers, each a bare goroutine: without this, one panic in
// any of them ends the process instead of the pass, and the next tick retries
// exactly as it does after an error.
func guardedStep(ctx context.Context, name string, step func(context.Context) error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			recovery.Log(r, name)
			err = fmt.Errorf("%s panicked: %v", name, r)
		}
	}()
	return step(ctx)
}

// warnVanished says so when the row a worker was working on is no longer
// there. An uninstall cascades plugin_deliveries away, so a delivery can
// disappear mid-flight; that is legitimate, but it must not be invisible.
func (o *Outbox) warnVanished(affected int64, d Delivery) {
	if affected != 0 || o.Log == nil {
		return
	}
	o.Log.Warn("plugin delivery vanished mid-flight; its outcome was dropped",
		"delivery_id", d.ID, "install_id", d.InstallID, "topic", d.Topic)
}
