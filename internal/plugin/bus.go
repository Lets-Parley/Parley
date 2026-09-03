package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Event is one thing that happened.
type Event struct {
	ID      int64
	Topic   string
	Payload json.RawMessage
}

// CoreHandler is an in-process subscriber. It runs synchronously on the
// publishing goroutine after the change has committed, which is what keeps the
// state broadcast a room depends on instant. It must not block.
type CoreHandler func(context.Context, Event)

// Bus has two deliberately different delivery paths. Core subscribers are
// in-process and synchronous. Plugin subscribers get a row in the outbox,
// written in the same transaction as the state change and drained by Outbox,
// which makes their delivery at-least-once and their handlers' idempotence a
// requirement rather than a nicety.
//
// The websocket hub is not a subscriber here and stays a dumb fanout.
type Bus struct {
	Pool *pgxpool.Pool

	mu   sync.RWMutex
	core map[string][]CoreHandler
}

// SubscribeCore registers an in-process subscriber for a topic.
func (b *Bus) SubscribeCore(topic string, h CoreHandler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.core == nil {
		b.core = map[string][]CoreHandler{}
	}
	b.core[topic] = append(b.core[topic], h)
}

// Publish records events with no accompanying state change.
func (b *Bus) Publish(ctx context.Context, events ...Event) error {
	return b.WithEvents(ctx, events, func(pgx.Tx) error { return nil })
}

// WithEvents runs fn and records events in one transaction, then fans them out
// to core subscribers once that transaction has committed.
//
// Taking the transaction rather than handing one out is what makes the outbox
// transactional: the event cannot be recorded without the change, the change
// cannot happen without the event, and a core subscriber never sees a change
// that rolled back.
func (b *Bus) WithEvents(ctx context.Context, events []Event, fn func(pgx.Tx) error) error {
	recorded := make([]Event, 0, len(events))
	err := pgx.BeginFunc(ctx, b.Pool, func(tx pgx.Tx) error {
		if err := fn(tx); err != nil {
			return err
		}
		for _, ev := range events {
			payload := ev.Payload
			if len(payload) == 0 {
				payload = json.RawMessage(`{}`)
			}
			if err := tx.QueryRow(ctx,
				`insert into plugin_events (topic, payload) values ($1, $2) returning id`,
				ev.Topic, []byte(payload),
			).Scan(&ev.ID); err != nil {
				return fmt.Errorf("recording %s: %w", ev.Topic, err)
			}
			// One delivery per enabled install that holds an events grant for
			// this topic. The grant is the subscription.
			if _, err := tx.Exec(ctx, `
				insert into plugin_deliveries (event_id, install_id)
				select $1, i.id
				from plugin_installs i
				join plugin_grants g on g.install_id = i.id
				where i.enabled and g.capability = $2 and g.scope = $3
				on conflict do nothing`, ev.ID, CapabilityEvents, ev.Topic); err != nil {
				return fmt.Errorf("queueing deliveries for %s: %w", ev.Topic, err)
			}
			ev.Payload = payload
			recorded = append(recorded, ev)
		}
		return nil
	})
	if err != nil {
		return err
	}

	for _, ev := range recorded {
		b.mu.RLock()
		handlers := b.core[ev.Topic]
		b.mu.RUnlock()
		for _, h := range handlers {
			h(ctx, ev)
		}
	}
	return nil
}
