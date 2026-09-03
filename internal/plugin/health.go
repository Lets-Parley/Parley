package plugin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Health states an operator screen renders.
const (
	// HealthOK is a plugin that is enabled and not in a cooldown.
	HealthOK = "healthy"
	// HealthDegraded is the breaker's recoverable middle stage: calls are
	// short-circuited until the cooldown expires.
	HealthDegraded = "degraded"
	// HealthDisabled is durable, and is either an operator's decision or the
	// breaker giving up. Which one it was is in Reason.
	HealthDisabled = "disabled"
	// HealthUnknown is what an enabled install reports when there is no
	// plugin host running to ask. It is not "healthy" — nobody has looked —
	// and it is not "degraded" or "disabled" either, since neither of those
	// is known to be true. The breaker's judgement lives entirely in the
	// host's memory, so with no host there is nothing to report.
	HealthUnknown = "unknown"
)

// Health is what the administration surface says about one install.
//
// The breaker's state is deliberately still in memory — it is a running
// judgement about this process, and persisting it would mean a restart could
// not clear a cooldown that has already expired. What was missing was any way
// to *see* it: a degraded plugin simply stopped doing anything, and no screen
// could tell that apart from a plugin with nothing to do. So the state is left
// where it is and read out through here, and the two facts that must outlive a
// restart — that an install is disabled, and that it was the breaker that
// disabled it — were already durable in plugin_installs.enabled and are
// re-derived from the store by the caller.
type Health struct {
	State string `json:"state"`
	// Reason is why, in words, or empty when the plugin is healthy.
	Reason string `json:"reason"`
	// LastError is the last failure the host recorded against this install in
	// this process. Empty after a restart, which is honest: nothing claims it
	// is a history.
	LastError string `json:"lastError,omitempty"`
	// RecoversAt is when a degraded plugin's cooldown expires.
	RecoversAt *time.Time `json:"recoversAt,omitempty"`
}

// Health reports the host's live judgement of one install. enabled comes from
// the caller's already-loaded install record rather than a second query, and is
// the durable half of the answer.
func (h *Host) Health(installID string, enabled bool) Health {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.breakers[installID]
	out := Health{State: HealthOK}
	if b != nil {
		out.LastError = b.lastErr
	}
	if !enabled {
		out.State = HealthDisabled
		out.Reason = "an operator switched it off"
		if b != nil && b.reason != "" {
			out.Reason = b.reason
		}
		return out
	}
	if b != nil && !b.allow(time.Now()) {
		until := b.openTill
		out.State = HealthDegraded
		out.Reason = "it failed repeatedly, so calls to it are being refused until the cooldown expires"
		out.RecoversAt = &until
	}
	return out
}

// TxHook is work a caller needs done inside the uninstall's own transaction.
// It exists for exactly one caller: the audit row. An uninstall is the one
// irreversible action on this surface, so "it happened and nothing recorded
// it" is not an acceptable outcome of a failed insert — the row goes in with
// the delete or the delete does not happen.
type TxHook func(ctx context.Context, tx pgx.Tx) error

// errBlocked aborts the uninstall transaction when a re-check inside it finds
// a session that blocks. It never escapes: uninstall swaps it for the
// BlockedError carrying what the operator has to deal with.
var errBlocked = errors.New("uninstall blocked")

// uninstall removes an install and everything cascading from it.
//
// It is a separate function from Disable and always will be: 0031_plugins.sql
// cascades from plugin_installs to grants, key-value storage, deliveries, jobs
// and encrypted secrets, so this destroys data that cannot be recovered.
// Routing a disable through it "because it also stops the plugin" would trade a
// reversible switch for an irreversible delete.
//
// It refuses while any session of a kind this plugin provides exists. Those
// sessions would otherwise be left naming a kind nothing can run.
//
// Everything happens in one transaction, in this order, and the order is the
// point:
//
//  1. Retire the kinds this install provides. session_kinds is retired rather
//     than deleted so historical sessions keep a kind that resolves — but until
//     now nothing performed the retirement, so after uninstalling a plugin with
//     no live sessions a *new* room of its kind could still be created naming a
//     provider that no longer existed.
//  2. Re-check for blocking sessions. The check and the delete used to be two
//     separate round trips on the pool with Go code between them, so a room of
//     a provided kind created in the gap left a live session behind a completed
//     uninstall. Retiring first shuts the door before looking through it:
//     Sessions.Create refuses a retired kind, so a creation that begins after
//     this statement commits cannot succeed.
//  3. Delete the install, scoped to the org, and run the caller's hook.
func (s *Store) uninstall(ctx context.Context, orgID, installID string, inTx TxHook) error {
	var blocked *BlockedError
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			update session_kinds set retired_at = now()
			where retired_at is null
			  and provider = (select name from plugin_installs where id = $1)`, installID); err != nil {
			return fmt.Errorf("retiring the kinds %s provides: %w", installID, err)
		}
		blocking, err := blockingSessions(ctx, tx, installID)
		if err != nil {
			return err
		}
		if len(blocking) > 0 {
			blocked = &BlockedError{Sessions: blocking}
			return errBlocked
		}
		tag, err := tx.Exec(ctx,
			`delete from plugin_installs where id = $1 and org_id = $2`, installID, orgID)
		if err != nil {
			return fmt.Errorf("uninstalling %s: %w", installID, err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNoSuchInstall
		}
		if inTx != nil {
			return inTx(ctx, tx)
		}
		return nil
	})
	if blocked != nil {
		// The retirement rolled back with it: a refused uninstall changes
		// nothing at all.
		return blocked
	}
	return err
}

// Forget drops everything this process was holding about an install that no
// longer exists: its compiled module and the breaker's judgement of it. Without
// it a later install reusing the name would inherit a cooldown earned by code
// that has been deleted.
func (h *Host) Forget(ctx context.Context, installID string) {
	h.evict(ctx, installID)
	h.mu.Lock()
	delete(h.breakers, installID)
	h.mu.Unlock()
}

// BlockingKind is one session kind a plugin provides, with how many sessions
// of it exist. The count is every session, ended ones included: a closed room
// is still history somebody can open, and history that cannot resolve its own
// kind is broken history.
type BlockingKind struct {
	Kind     string `json:"kind"`
	Display  string `json:"display"`
	Sessions int    `json:"sessions"`
}

// BlockedError is the refusal, carrying what an operator has to deal with
// before the uninstall can go ahead. A refusal that does not say what blocks it
// is an error message, not a control.
type BlockedError struct{ Sessions []BlockingKind }

func (e *BlockedError) Error() string {
	if len(e.Sessions) == 0 {
		return "the uninstall is blocked"
	}
	msg := "this plugin cannot be uninstalled while sessions of the kinds it provides still exist: "
	for i, k := range e.Sessions {
		if i > 0 {
			msg += ", "
		}
		msg += fmt.Sprintf("%s (%d)", k.Display, k.Sessions)
	}
	return msg + ". Delete or export those rooms first."
}

// BlockingSessions lists the kinds this install provides that still have
// sessions. Provision is the session_kinds.provider column: a plugin provides
// the kinds whose provider is its name.
func (s *Store) BlockingSessions(ctx context.Context, installID string) ([]BlockingKind, error) {
	return blockingSessions(ctx, s.Pool, installID)
}

// querier is whatever can run the blocking-session query: the pool for a read,
// or the uninstall's own transaction for the re-check that decides the delete.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func blockingSessions(ctx context.Context, q querier, installID string) ([]BlockingKind, error) {
	rows, err := q.Query(ctx, `
		select k.kind, k.display, count(sess.id)
		from plugin_installs p
		join session_kinds k on k.provider = p.name
		left join sessions sess on sess.kind = k.kind
		where p.id = $1
		group by k.kind, k.display
		having count(sess.id) > 0
		order by k.kind`, installID)
	if err != nil {
		return nil, fmt.Errorf("looking for sessions that block uninstalling %s: %w", installID, err)
	}
	defer rows.Close()
	var out []BlockingKind
	for rows.Next() {
		var k BlockingKind
		if err := rows.Scan(&k.Kind, &k.Display, &k.Sessions); err != nil {
			return nil, fmt.Errorf("reading a blocking kind for %s: %w", installID, err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}
