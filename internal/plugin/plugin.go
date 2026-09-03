// Package plugin holds the foundations a plugin host needs before it can
// exist: the installs and their capability grants, the event bus, the
// transactional outbox that carries events to plugins, namespaced key-value
// storage with a quota, encrypted secrets, and a job queue.
//
// No plugin code runs here. Nothing in this package executes WASM, opens a
// socket, or trusts anything a plugin says.
//
// # Delivery is at-least-once
//
// Core subscribers are in-process and synchronous, so the state broadcast a
// room depends on stays instant. Plugin subscribers go through the outbox: a
// row written inside the same transaction as the state change, drained later
// by a worker. That worker can crash between delivering and marking a row
// delivered, so **every plugin event handler must be idempotent** — handling
// the same event twice must reach the same result as handling it once.
package plugin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Capabilities a grant can name. A grant of CapabilityEvents is also how a
// plugin subscribes: its scope is the event topic.
const (
	CapabilityEvents  = "events"
	CapabilitySecrets = "secrets"
)

// ErrNoSecretKey is returned when a plugin asks for the secrets capability on
// an instance with no encryption key configured. Refusing the install is the
// point: the alternative is storing the secret in the clear.
var ErrNoSecretKey = errors.New("plugin secrets are not available: no encryption key is configured")

// Store is the durable side of the plugin host.
type Store struct {
	Pool *pgxpool.Pool
	// Cipher encrypts plugin secrets at rest. Nil means secrets are
	// unavailable, not that they are stored in the clear.
	Cipher *Cipher
}

// Grant is one capability an install is allowed to use, optionally narrowed to
// a scope. An empty scope is the whole capability.
type Grant struct {
	Capability string
	Scope      string
}

// Install is an installed plugin.
type Install struct {
	ID         string
	Name       string
	Version    string
	Enabled    bool
	QuotaBytes int64
}

// InstallRequest is what a caller asks to install.
type InstallRequest struct {
	Name       string
	Version    string
	Grants     []Grant
	QuotaBytes int64
}

// Install records a plugin and its grants in one transaction, so a plugin is
// never installed without the grants it was approved with.
func (s *Store) Install(ctx context.Context, req InstallRequest) (Install, error) {
	if err := checkGrants(s.Cipher, req.Name, req.Grants); err != nil {
		return Install{}, err
	}

	var out Install
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			insert into plugin_installs (name, version, kv_quota_bytes)
			values ($1, $2, $3)
			returning id, name, version, enabled, kv_quota_bytes`,
			req.Name, req.Version, req.QuotaBytes,
		).Scan(&out.ID, &out.Name, &out.Version, &out.Enabled, &out.QuotaBytes); err != nil {
			return fmt.Errorf("inserting install: %w", err)
		}
		for _, g := range req.Grants {
			if _, err := tx.Exec(ctx, `
				insert into plugin_grants (install_id, capability, scope)
				values ($1, $2, $3)
				on conflict do nothing`, out.ID, g.Capability, g.Scope); err != nil {
				return fmt.Errorf("granting %s: %w", g.Capability, err)
			}
		}
		return nil
	})
	if err != nil {
		return Install{}, err
	}
	return out, nil
}

// Prune drops events older than the retention window whose deliveries have all
// reached a terminal state, along with those deliveries. An outbox that never
// prunes is an unbounded table.
//
// An event still waiting on a delivery is left alone however old it is:
// dropping it would silently cancel work that was promised at-least-once.
// Deliveries that keep failing reach 'dead' rather than 'pending', so a broken
// subscriber cannot pin the table open forever.
func (s *Store) Prune(ctx context.Context, retain time.Duration) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `
		delete from plugin_events e
		where e.created_at < now() - $1::interval
		  and not exists (
			select 1 from plugin_deliveries d
			where d.event_id = e.id and d.state = 'pending'
		  )`, retain.String())
	if err != nil {
		return 0, fmt.Errorf("pruning plugin events: %w", err)
	}
	return tag.RowsAffected(), nil
}

// RunRetention prunes past the retention window and reconciles the storage
// quota counters, on a ticker, until ctx is done.
//
// The reconciliation rides along with the prune rather than getting its own
// schedule: both are the same kind of work — the periodic pass that keeps a
// number nobody watches from quietly becoming wrong.
func (s *Store) RunRetention(ctx context.Context, retain, every time.Duration, log *slog.Logger) {
	runLoop(ctx, every, log, "plugin retention", func(ctx context.Context) error {
		pruned, err := s.Prune(ctx, retain)
		if err != nil {
			return err
		}
		drifted, err := s.ReconcileQuotas(ctx)
		if err != nil {
			return err
		}
		if (pruned > 0 || drifted > 0) && log != nil {
			log.Info("plugin retention pass", "events_pruned", pruned, "quota_counters_corrected", drifted)
		}
		return nil
	})
}
