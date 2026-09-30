package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

// Capabilities a host function checks for. Each one is checked inside the host
// function, immediately before the effect, against the install record — never
// against the bundle's own manifest, which the plugin writes.
const (
	// CapabilityKV is namespaced key-value storage. The grant's scope is the
	// bucket a key lands in.
	CapabilityKV = "kv"
	// CapabilityFetch is outbound https. The grant's scope is one allowlist
	// entry; several grants are several entries.
	CapabilityFetch = "fetch"
	// CapabilityLog is writing to the server log.
	CapabilityLog = "log"
	// CapabilitySessionRead is reading redacted session state.
	CapabilitySessionRead = "session:read"
	// CapabilitySessionPatch is proposing a change to session state.
	CapabilitySessionPatch = "session:patch"
	// CapabilityJobs is enqueueing deferred work.
	CapabilityJobs = "jobs"
	// CapabilityEmit is publishing an event of the plugin's own. It is
	// deliberately not CapabilityEvents: subscribing to a topic and being able
	// to fabricate one are different powers.
	CapabilityEmit = "emit"
)

// ErrNotGranted is returned by a host function whose capability the install
// does not hold. Every refusal from the grant check is this error, so a
// fixture can assert the mechanism rather than a message.
var ErrNotGranted = fmt.Errorf("the plugin does not hold this capability")

// ErrUpgradePending is returned when an upgrade asks for capabilities beyond
// what was approved. The install keeps its old version and its old grants.
var ErrUpgradePending = fmt.Errorf("the upgrade requests wider capabilities and is waiting for an operator to approve it")

// State is what a host function checks against: the live install record and
// the grants that are in force right now.
type State struct {
	Install Install
	Grants  []Grant
}

// Allows reports whether the state holds a capability, optionally narrowed to
// a scope. A grant with an empty scope is the whole capability.
func (s State) Allows(capability, scope string) bool {
	for _, g := range s.Grants {
		if g.Capability != capability {
			continue
		}
		if g.Scope == "" || g.Scope == scope {
			return true
		}
	}
	return false
}

// Scopes returns every scope granted for a capability.
func (s State) Scopes(capability string) []string {
	var out []string
	for _, g := range s.Grants {
		if g.Capability == capability && g.Scope != "" {
			out = append(out, g.Scope)
		}
	}
	return out
}

// State reads the install and its grants. A host function calls this on every
// call rather than caching it, so revoking a grant or disabling an install
// takes effect on the next call instead of the next restart.
func (s *Store) State(ctx context.Context, installID string) (State, error) {
	var out State
	var digest, keyID, match *string
	err := s.Pool.QueryRow(ctx, `
		select i.id, i.org_id, i.name, i.version, i.enabled, i.kv_quota_bytes, i.bundle_digest, i.bundle_key_id, b.digest
		from plugin_installs i
		left join plugin_bundles b on b.digest = i.bundle_digest and b.key_id = i.bundle_key_id
			and b.version = i.version
		where i.id = $1`, installID).
		Scan(&out.Install.ID, &out.Install.OrgID, &out.Install.Name, &out.Install.Version,
			&out.Install.Enabled, &out.Install.QuotaBytes, &digest, &keyID, &match)
	if err != nil {
		return State{}, fmt.Errorf("reading install %s: %w", installID, err)
	}
	// A pin is authoritative only while its bundle carries the install's
	// version. An older binary mid-rollout can bump the version without
	// moving the pin; this install then resolves by name and version until
	// the boot pin re-derives it.
	if digest != nil && keyID != nil {
		out.Install.PinnedTo = &BundleRef{Digest: *digest, KeyID: *keyID}
		if match != nil {
			out.Install.Bundle = out.Install.PinnedTo
		}
	}
	rows, err := s.Pool.Query(ctx,
		`select capability, scope from plugin_grants where install_id = $1`, installID)
	if err != nil {
		return State{}, fmt.Errorf("reading grants for %s: %w", installID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.Capability, &g.Scope); err != nil {
			return State{}, fmt.Errorf("reading a grant for %s: %w", installID, err)
		}
		out.Grants = append(out.Grants, g)
	}
	return out, rows.Err()
}

// SetEnabled turns an install on or off. It is the host's own path — the
// breaker disabling a plugin that keeps failing — and takes no org, because
// the host is acting on an install it is already running rather than on an id
// somebody put in a URL. The operator's path is Admin.SetEnabled.
func (s *Store) SetEnabled(ctx context.Context, installID string, enabled bool) error {
	if _, err := s.Pool.Exec(ctx,
		`update plugin_installs set enabled = $2 where id = $1`, installID, enabled); err != nil {
		return fmt.Errorf("setting install %s enabled=%t: %w", installID, enabled, err)
	}
	s.changed(ctx)
	return nil
}

// setEnabled is the operator's path, and carries the org a second time so that
// breaking Admin.own alone does not open it.
func (s *Store) setEnabled(ctx context.Context, orgID, installID string, enabled bool) error {
	tag, err := s.Pool.Exec(ctx,
		`update plugin_installs set enabled = $3 where id = $1 and org_id = $2`, installID, orgID, enabled)
	if err != nil {
		return fmt.Errorf("setting install %s enabled=%t: %w", installID, enabled, err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoSuchInstall
	}
	s.changed(ctx)
	return nil
}

// PendingUpgrade is a requested version whose grants nobody has approved.
type PendingUpgrade struct {
	Version string
	Grants  []Grant
}

// Upgrade moves an install to a new version.
//
// It applies straight away only when the new version asks for nothing the
// operator has not already approved. An upgrade that widens the grants is
// recorded as pending and returns ErrUpgradePending: the running version and
// the grants in force are left exactly as they were, because the alternative
// is a plugin granting itself capabilities by shipping a release.
//
// kinds is the session kinds this version provides. A nil slice leaves the
// kinds already on the record alone (callers that are not carrying a package);
// a non-nil slice — including empty — is canonicalised and written in the same
// transaction as the version (or pending_version) bump.
func (s *Store) Upgrade(ctx context.Context, installID, version string, want []Grant, kinds []KindDef) error {
	return s.UpgradeTo(ctx, installID, version, want, kinds, nil)
}

// UpgradeTo is Upgrade that also moves the install's pin to pin. A nil pin
// never clears an existing one: the old pin stays, stops being authoritative
// because its version no longer matches (see State), and the boot pin
// re-derives it. A widening upgrade stages the pin with the grants.
func (s *Store) UpgradeTo(ctx context.Context, installID, version string, want []Grant, kinds []KindDef, pin *BundleRef) error {
	current, err := s.State(ctx, installID)
	if err != nil {
		return err
	}
	if err := checkGrants(s.Cipher, current.Install.Name, want); err != nil {
		return err
	}
	// Screened before the transaction, matching Install: a bad declaration
	// must not bump the version and then fail the kinds write.
	var screened []KindDef
	if kinds != nil {
		screened, err = canonicalKinds(kinds)
		if err != nil {
			return err
		}
	}

	widens := false
	for _, g := range want {
		if !current.Allows(g.Capability, g.Scope) {
			widens = true
			break
		}
	}

	// The sentinel is returned after the transaction, not from inside it: a
	// pending upgrade has to be recorded, and an error out of BeginFunc rolls
	// the record back.
	if err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// The install row first, as ApproveUpgrade takes it, so the two can
		// never wait on each other's locks in opposite orders.
		if _, err := tx.Exec(ctx, `select 1 from plugin_installs where id = $1 for update`, installID); err != nil {
			return fmt.Errorf("locking %s: %w", installID, err)
		}
		if _, err := tx.Exec(ctx, `delete from plugin_pending_grants where install_id = $1`, installID); err != nil {
			return fmt.Errorf("clearing the pending grants for %s: %w", installID, err)
		}
		if !widens {
			if _, err := tx.Exec(ctx,
				`update plugin_installs set version = $2, pending_version = null, pending_kinds = null,
				 bundle_digest = coalesce($3, bundle_digest), bundle_key_id = coalesce($4, bundle_key_id),
				 pending_digest = null, pending_key_id = null where id = $1`,
				installID, version, pin.digest(), pin.keyID()); err != nil {
				return fmt.Errorf("upgrading %s: %w", installID, err)
			}
			if err := recordPin(ctx, tx, installID, pin); err != nil {
				return err
			}
			if err := replaceGrants(ctx, tx, installID, want); err != nil {
				return err
			}
		} else {
			// The kinds wait with the grants: a ceremony the pending version
			// declares is not offered under the grants of the one running.
			// Screened now, so a bad or taken name is refused at upload rather
			// than at approval. A re-upload overwrites what was staged.
			var staged []byte
			if kinds != nil {
				if err := checkKindsFree(ctx, tx, current.Install.OrgID, current.Install.Name, screened); err != nil {
					return err
				}
				if staged, err = json.Marshal(screened); err != nil {
					return fmt.Errorf("staging the kinds for %s: %w", installID, err)
				}
			}
			if _, err := tx.Exec(ctx,
				`update plugin_installs set pending_version = $2, pending_kinds = $3,
				 pending_digest = $4, pending_key_id = $5 where id = $1`,
				installID, version, staged, pin.digest(), pin.keyID()); err != nil {
				return fmt.Errorf("recording the pending upgrade for %s: %w", installID, err)
			}
			for _, g := range want {
				if _, err := tx.Exec(ctx, `
					insert into plugin_pending_grants (install_id, capability, scope)
					values ($1, $2, $3) on conflict do nothing`, installID, g.Capability, g.Scope); err != nil {
					return fmt.Errorf("recording a pending grant for %s: %w", installID, err)
				}
			}
		}
		if kinds != nil && !widens {
			if err := syncKinds(ctx, tx, current.Install.OrgID, current.Install.Name, screened); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	s.changed(ctx)
	if widens {
		return ErrUpgradePending
	}
	return nil
}

// Pending returns the upgrade waiting on an operator, if any.
func (s *Store) Pending(ctx context.Context, installID string) (PendingUpgrade, bool, error) {
	var version *string
	if err := s.Pool.QueryRow(ctx,
		`select pending_version from plugin_installs where id = $1`, installID).Scan(&version); err != nil {
		return PendingUpgrade{}, false, fmt.Errorf("reading the pending upgrade for %s: %w", installID, err)
	}
	if version == nil {
		return PendingUpgrade{}, false, nil
	}
	rows, err := s.Pool.Query(ctx,
		`select capability, scope from plugin_pending_grants where install_id = $1`, installID)
	if err != nil {
		return PendingUpgrade{}, false, fmt.Errorf("reading the pending grants for %s: %w", installID, err)
	}
	defer rows.Close()
	out := PendingUpgrade{Version: *version}
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.Capability, &g.Scope); err != nil {
			return PendingUpgrade{}, false, fmt.Errorf("reading a pending grant for %s: %w", installID, err)
		}
		out.Grants = append(out.Grants, g)
	}
	if err := rows.Err(); err != nil {
		return PendingUpgrade{}, false, err
	}
	sort.Slice(out.Grants, func(i, j int) bool {
		if out.Grants[i].Capability != out.Grants[j].Capability {
			return out.Grants[i].Capability < out.Grants[j].Capability
		}
		return out.Grants[i].Scope < out.Grants[j].Scope
	})
	return out, true, nil
}

// ApproveUpgrade is the operator's decision. Only this puts a wider grant set
// into force.
func (s *Store) ApproveUpgrade(ctx context.Context, installID string) error {
	current, err := s.State(ctx, installID)
	if err != nil {
		return err
	}
	// Everything the approval acts on is read under the row lock, so an
	// upload that lands meanwhile cannot swap the grants being approved.
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		var version, digest, keyID *string
		var staged []byte
		if err := tx.QueryRow(ctx,
			`select pending_version, pending_kinds, pending_digest, pending_key_id from plugin_installs where id = $1 for update`,
			installID).Scan(&version, &staged, &digest, &keyID); err != nil {
			return fmt.Errorf("reading the pending upgrade for %s: %w", installID, err)
		}
		if version == nil {
			return fmt.Errorf("approving an upgrade for %s: there is nothing pending", installID)
		}
		rows, err := tx.Query(ctx,
			`select capability, scope from plugin_pending_grants where install_id = $1`, installID)
		if err != nil {
			return fmt.Errorf("reading the pending grants for %s: %w", installID, err)
		}
		grants, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Grant, error) {
			var g Grant
			return g, r.Scan(&g.Capability, &g.Scope)
		})
		if err != nil {
			return fmt.Errorf("reading a pending grant for %s: %w", installID, err)
		}
		// The plugin's name, as every other call site passes: an operator
		// reading a refused approval wants to know which plugin it was.
		if err := checkGrants(s.Cipher, current.Install.Name, grants); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`update plugin_installs set version = $2, pending_version = null, pending_kinds = null,
			 bundle_digest = coalesce($3, bundle_digest), bundle_key_id = coalesce($4, bundle_key_id),
			 pending_digest = null, pending_key_id = null where id = $1`,
			installID, *version, digest, keyID); err != nil {
			return fmt.Errorf("approving the upgrade for %s: %w", installID, err)
		}
		if digest != nil && keyID != nil {
			if err := recordPin(ctx, tx, installID, &BundleRef{Digest: *digest, KeyID: *keyID}); err != nil {
				return err
			}
		}
		// NULL: the upgrade declared no kinds, so the current ones stay. A
		// declared set, even an empty one, is applied — and syncKinds'
		// seedKinds re-checks ownership here, so a name another org took
		// while this waited is ErrKindTaken and the whole approval rolls back.
		if staged != nil {
			var kinds []KindDef
			if err := json.Unmarshal(staged, &kinds); err != nil {
				return fmt.Errorf("reading the staged kinds for %s: %w", installID, err)
			}
			if err := syncKinds(ctx, tx, current.Install.OrgID, current.Install.Name, kinds); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `delete from plugin_pending_grants where install_id = $1`, installID); err != nil {
			return fmt.Errorf("clearing the pending grants for %s: %w", installID, err)
		}
		return replaceGrants(ctx, tx, installID, grants)
	})
	if err != nil {
		return err
	}
	s.changed(ctx)
	return nil
}

func replaceGrants(ctx context.Context, tx pgx.Tx, installID string, grants []Grant) error {
	if _, err := tx.Exec(ctx, `delete from plugin_grants where install_id = $1`, installID); err != nil {
		return fmt.Errorf("clearing the grants for %s: %w", installID, err)
	}
	for _, g := range grants {
		if _, err := tx.Exec(ctx, `
			insert into plugin_grants (install_id, capability, scope)
			values ($1, $2, $3) on conflict do nothing`, installID, g.Capability, g.Scope); err != nil {
			return fmt.Errorf("granting %s to %s: %w", g.Capability, installID, err)
		}
	}
	return nil
}

// checkGrants refuses a grant set the host could not honour. Secrets without a
// key would mean storing them in the clear, and a fetch allowlist entry the
// guard cannot enforce honestly is worse than no entry at all — both are
// caught here, before the install exists, rather than at the first call.
func checkGrants(cipher *Cipher, name string, grants []Grant) error {
	for _, g := range grants {
		switch g.Capability {
		case CapabilitySecrets:
			if cipher == nil {
				return fmt.Errorf("%s: %w", name, ErrNoSecretKey)
			}
		case CapabilityFetch:
			if err := ValidateAllowPattern(g.Scope); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		}
	}
	return nil
}
