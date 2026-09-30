package plugin

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin/bundle"
)

// BundleStore is the plugin_bundles table, with PLUGIN_DIR as the fallback.
//
// The lookup rule, for a name and version: among the rows with that name and
// version whose key_id this instance trusts now — a key in Trusted, or ” for
// an unsigned bundle only while AllowUnsigned is on — the one with the latest
// uploaded_at wins, ties broken by the smaller (digest, key_id). With no such
// row, the files in Dir are used as before. A row is the whole bundle, so a
// row without a ui.js means no UI; it never falls through to a file on disk.
//
// Trust is checked at read as well as at import, so removing a key from
// PLUGIN_TRUSTED_KEYS stops its bundles being served without deleting a row.
//
// Bytes are cached per pod by digest. A digest names content, so an entry is
// never stale and the cache only ever misses: a hit still resolves the digest
// (a narrow index read) but never re-reads the bytes.
type BundleStore struct {
	Pool          *pgxpool.Pool
	Dir           string
	Trusted       []ed25519.PublicKey
	AllowUnsigned bool

	mu    sync.Mutex
	cache map[string]*bundle.Bundle
}

func (s *BundleStore) keyIDs() []string {
	ids := make([]string, 0, len(s.Trusted)+1)
	for _, k := range s.Trusted {
		ids = append(ids, bundle.KeyID(k))
	}
	if s.AllowUnsigned {
		ids = append(ids, "")
	}
	return ids
}

// Stored returns the stored bundle for name and version under the rule above,
// or nil with no error when there is no such row.
func (s *BundleStore) Stored(ctx context.Context, name, version string) (*bundle.Bundle, error) {
	if s == nil || s.Pool == nil {
		return nil, nil
	}
	var digest, keyID string
	err := s.Pool.QueryRow(ctx, `
		select digest, key_id from plugin_bundles
		where name = $1 and version = $2 and key_id = any($3)
		order by uploaded_at desc, digest, key_id limit 1`,
		name, version, s.keyIDs()).Scan(&digest, &keyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolving the bundle for %s %s: %w", name, version, err)
	}
	s.mu.Lock()
	b, ok := s.cache[digest]
	s.mu.Unlock()
	if ok {
		return b, nil
	}
	b = &bundle.Bundle{Digest: digest, KeyID: keyID}
	var manifest string
	if err := s.Pool.QueryRow(ctx,
		`select manifest::text, wasm, ui, slots from plugin_bundles where digest = $1 and key_id = $2`,
		digest, keyID).Scan(&manifest, &b.Wasm, &b.UI, &b.Slots); err != nil {
		return nil, fmt.Errorf("reading bundle %s: %w", digest, err)
	}
	b.Manifest = []byte(manifest)
	s.mu.Lock()
	if s.cache == nil {
		s.cache = map[string]*bundle.Bundle{}
	}
	s.cache[digest] = b
	s.mu.Unlock()
	return b, nil
}

// Load implements Bundles: a stored bundle's wasm, else "<name>-<version>.wasm"
// in Dir.
func (s *BundleStore) Load(ctx context.Context, name, version string) ([]byte, error) {
	b, err := s.Stored(ctx, name, version)
	if err != nil {
		return nil, err
	}
	if b != nil {
		return b.Wasm, nil
	}
	if s.Dir == "" {
		return nil, fmt.Errorf("no stored bundle for %s %s and no PLUGIN_DIR: %w", name, version, ErrNoBundle)
	}
	return DirBundles(s.Dir).Load(ctx, name, version)
}

// Insert stores a verified bundle. It is idempotent: a (digest, key_id) that
// is already there is left exactly as it was. uploadedBy is nil for a bundle
// imported from PLUGIN_DIR at boot.
func (s *BundleStore) Insert(ctx context.Context, b *bundle.Bundle, uploadedBy *string) error {
	var m struct{ Name, Version string }
	if err := json.Unmarshal(b.Manifest, &m); err != nil || m.Name == "" || m.Version == "" {
		return fmt.Errorf("bundle %s: the manifest names no name and version", b.Digest)
	}
	_, err := s.Pool.Exec(ctx, `
		insert into plugin_bundles (digest, key_id, name, version, manifest, wasm, ui, slots, uploaded_by)
		values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
		on conflict do nothing`,
		b.Digest, b.KeyID, m.Name, m.Version, string(b.Manifest), b.Wasm, b.UI, b.Slots, uploadedBy)
	if err != nil {
		return fmt.Errorf("storing bundle %s: %w", b.Digest, err)
	}
	return nil
}

// Import verifies every *.parley file in Dir against Trusted (unsigned only
// under AllowUnsigned) and stores the ones that pass. A refused or unreadable
// file is logged and skipped, never fatal. Concurrent imports from several
// replicas are safe: the insert does nothing on conflict.
func (s *BundleStore) Import(ctx context.Context, log *slog.Logger) {
	if s.Dir == "" || s.Pool == nil {
		return
	}
	paths, err := filepath.Glob(filepath.Join(s.Dir, "*.parley"))
	if err != nil {
		log.Warn("could not list plugin bundles to import", "dir", s.Dir, "error", err)
		return
	}
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			log.Warn("could not read a plugin bundle", "file", path, "error", err)
			continue
		}
		b, err := bundle.Verify(f, s.Trusted, s.AllowUnsigned)
		f.Close()
		if err != nil {
			log.Warn("refused a plugin bundle", "file", path, "error", err)
			continue
		}
		if err := s.Insert(ctx, b, nil); err != nil {
			log.Warn("could not store a plugin bundle", "file", path, "error", err)
			continue
		}
		log.Info("imported a plugin bundle", "file", path, "digest", b.Digest, "key_id", b.KeyID)
	}
}
