package plugin

import (
	"context"
	"fmt"
	"time"
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

// Uninstall removes an install and everything cascading from it.
//
// It is a separate function from Disable and always will be: 0031_plugins.sql
// cascades from plugin_installs to grants, key-value storage, deliveries, jobs
// and encrypted secrets, so this destroys data that cannot be recovered.
// Routing a disable through it "because it also stops the plugin" would trade a
// reversible switch for an irreversible delete.
//
// It refuses while any session of a kind this plugin provides exists. Those
// sessions would otherwise be left naming a kind nothing can run — the same
// reason session_kinds is retired rather than deleted.
func (s *Store) Uninstall(ctx context.Context, installID string) error {
	blocking, err := s.BlockingSessions(ctx, installID)
	if err != nil {
		return err
	}
	if len(blocking) > 0 {
		return &BlockedError{Sessions: blocking}
	}
	tag, err := s.Pool.Exec(ctx, `delete from plugin_installs where id = $1`, installID)
	if err != nil {
		return fmt.Errorf("uninstalling %s: %w", installID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("uninstalling %s: there is no such install", installID)
	}
	return nil
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
	rows, err := s.Pool.Query(ctx, `
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
