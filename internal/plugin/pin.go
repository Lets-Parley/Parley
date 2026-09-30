package plugin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/plugin/bundle"
)

// BundleRef names one plugin_bundles row: the content digest and the key that
// signed it (” for an unsigned bundle).
type BundleRef struct {
	Digest string `json:"digest"`
	KeyID  string `json:"key_id"`
}

func (r *BundleRef) digest() *string {
	if r == nil {
		return nil
	}
	return &r.Digest
}

func (r *BundleRef) keyID() *string {
	if r == nil {
		return nil
	}
	return &r.KeyID
}

// String is the cache key a pinned module is compiled under.
func (r BundleRef) String() string { return r.Digest + "/" + r.KeyID }

// PinnedBundles is a Bundles that can also serve an install by the exact row it
// is pinned to. The host asks it whenever an install carries a pin, so a newer
// row for the same name and version never runs in its place.
type PinnedBundles interface {
	ResolvePinned(ctx context.Context, ref BundleRef) (string, error)
	LoadPinned(ctx context.Context, ref BundleRef) ([]byte, string, error)
}

// recordPin appends ref to the install's history, the list a rollback may
// choose from.
func recordPin(ctx context.Context, tx pgx.Tx, installID string, ref *BundleRef) error {
	if ref == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		insert into plugin_install_history (install_id, digest, key_id) values ($1, $2, $3)
		on conflict (install_id, digest, key_id) do update set pinned_at = now()`,
		installID, ref.Digest, ref.KeyID); err != nil {
		return fmt.Errorf("recording the bundle %s ran: %w", installID, err)
	}
	return nil
}

// Pinned is the verified bundle ref names, or ErrBundleUntrusted when the row
// does not exist or this instance does not trust it now.
func (s *BundleStore) Pinned(ctx context.Context, ref BundleRef) (*bundle.Bundle, error) {
	if s == nil || s.Pool == nil {
		return nil, fmt.Errorf("%s: %w", ref, ErrNoBundle)
	}
	var name, version string
	err := s.Pool.QueryRow(ctx, `select name, version from plugin_bundles where digest = $1 and key_id = $2`,
		ref.Digest, ref.KeyID).Scan(&name, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%s: %w", ref, ErrBundleUntrusted)
	}
	if err != nil {
		return nil, fmt.Errorf("reading bundle %s: %w", ref, err)
	}
	return s.verified(ctx, resolution{digest: ref.Digest, keyID: ref.KeyID, found: true}, name, version)
}

// ResolvePinned implements PinnedBundles. Trust is re-checked on every call.
func (s *BundleStore) ResolvePinned(_ context.Context, ref BundleRef) (string, error) {
	if !s.trusts(ref.KeyID) {
		return "", fmt.Errorf("%s: %w", ref, ErrBundleUntrusted)
	}
	return ref.String(), nil
}

// LoadPinned implements PinnedBundles.
func (s *BundleStore) LoadPinned(ctx context.Context, ref BundleRef) ([]byte, string, error) {
	b, err := s.Pinned(ctx, ref)
	if err != nil {
		return nil, "", err
	}
	return b.Wasm, ref.String(), nil
}

// TrustedKeyIDs is the key ids this store accepts now, ” among them only
// under AllowUnsigned.
func (s *BundleStore) TrustedKeyIDs() []string {
	out := []string{}
	for _, k := range s.Trusted {
		out = append(out, bundle.KeyID(k))
	}
	if s.AllowUnsigned {
		out = append(out, "")
	}
	return out
}

// pinLockID is the boot pin's own advisory lock. It must never be
// migrationLockID (AGENTS.md gotcha 3).
const pinLockID int64 = 0x7061726c657970

// PinInstalls pins every unpinned install to the trusted stored bundle for its
// name and version, signed preferred. It runs at boot after the PLUGIN_DIR
// import, under its own transaction-scoped advisory lock so replicas booting
// together do it once. An install with no match is left alone: it keeps
// running from loose files and shows as "not in catalogue", never disabled.
func (s *Store) PinInstalls(ctx context.Context, trusted []string, log *slog.Logger) error {
	var pinned int64
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1)`, pinLockID); err != nil {
			return fmt.Errorf("taking the pin lock: %w", err)
		}
		tag, err := tx.Exec(ctx, `
			with match as (
				select distinct on (i.id) i.id, b.digest, b.key_id
				from plugin_installs i
				join plugin_bundles b on b.name = i.name and b.version = i.version
				where i.bundle_digest is null and b.key_id = any($1)
				order by i.id, b.key_id = ''
			), pinned as (
				update plugin_installs i set bundle_digest = m.digest, bundle_key_id = m.key_id
				from match m where i.id = m.id
				returning i.id, m.digest, m.key_id
			)
			insert into plugin_install_history (install_id, digest, key_id)
			select id, digest, key_id from pinned on conflict do nothing`, trusted)
		if err != nil {
			return fmt.Errorf("pinning installs to stored bundles: %w", err)
		}
		pinned = tag.RowsAffected()
		return nil
	})
	if err != nil {
		return err
	}
	if pinned > 0 && log != nil {
		log.Info("pinned plugin installs to their stored bundles", "installs", pinned)
	}
	return nil
}

// Ran reports whether this org's install was ever pinned to ref. It is the
// whole rollback check: a rollback names a bundle the install already ran.
func (a *Admin) Ran(ctx context.Context, installID string, ref BundleRef) (bool, error) {
	if err := a.own(ctx, installID); err != nil {
		return false, err
	}
	var ran bool
	err := a.s.Pool.QueryRow(ctx, `
		select exists (select 1 from plugin_install_history
		where install_id = $1 and digest = $2 and key_id = $3)`, installID, ref.Digest, ref.KeyID).Scan(&ran)
	if err != nil {
		return false, fmt.Errorf("reading the bundles %s ran: %w", installID, err)
	}
	return ran, nil
}

// PinnedVersion is one bundle an install ran, with the version it carries.
type PinnedVersion struct {
	BundleRef
	Version string `json:"version"`
}

// History is the bundles this org's install has been pinned to, newest first.
func (a *Admin) History(ctx context.Context, installID string) ([]PinnedVersion, error) {
	if err := a.own(ctx, installID); err != nil {
		return nil, err
	}
	rows, err := a.s.Pool.Query(ctx, `
		select h.digest, h.key_id, b.version from plugin_install_history h
		join plugin_bundles b using (digest, key_id)
		where h.install_id = $1 order by h.pinned_at desc`, installID)
	if err != nil {
		return nil, fmt.Errorf("reading the bundles %s ran: %w", installID, err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (PinnedVersion, error) {
		var p PinnedVersion
		return p, r.Scan(&p.Digest, &p.KeyID, &p.Version)
	})
}

// UpgradeTo moves one of this org's installs to a version and pin.
func (a *Admin) UpgradeTo(ctx context.Context, installID, version string, want []Grant, kinds []KindDef, pin *BundleRef) error {
	if err := a.own(ctx, installID); err != nil {
		return err
	}
	return a.s.UpgradeTo(ctx, installID, version, want, kinds, pin)
}

// LoadedBundles is the identity of every module resident on this pod, for
// /readyz. A pinned module's is its digest and key id.
func (h *Host) LoadedBundles() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.cache))
	for _, e := range h.cache {
		out = append(out, e.key)
	}
	return out
}
