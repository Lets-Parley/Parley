package plugin

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin/bundle"
)

var (
	// ErrBundleConflict is a bundle for a name and version another publisher
	// already holds. The first signed bundle wins; an unsigned one never
	// displaces or competes with it.
	ErrBundleConflict = errors.New("a different bundle is already stored for this name and version")
	// ErrBundleUntrusted is a stored bundle this instance does not trust now.
	ErrBundleUntrusted = errors.New("the stored bundle for this name and version is not trusted by this instance")
)

// DefaultResolveTTL is how long a pod reuses which row answers a name and
// version before asking the table again.
const DefaultResolveTTL = 5 * time.Second

// BundleStore is the plugin_bundles table, with PLUGIN_DIR's loose files as a
// legacy fallback.
//
// The rule, for a name and version: the stored row answers — the signed one
// if there is one, else the unsigned one. It is used only if its archive
// verifies against the trust set this store holds now (Trusted, and unsigned
// only under AllowUnsigned); the key_id column is an index, never authority.
// A row that does not verify is refused and never falls back to a file. Only
// when no row exists for that name and version are the loose files in Dir
// read, with a warning each time: they are unsigned and legacy.
//
// Which row answers is cached for ResolveTTL, so a row stored by another pod
// is picked up within that bound. Trust is re-checked on every resolve.
// Verified bundles are cached by digest and key id; their bytes never change.
type BundleStore struct {
	Pool          *pgxpool.Pool
	Dir           string
	Trusted       []ed25519.PublicKey
	AllowUnsigned bool
	Log           *slog.Logger
	// ResolveTTL overrides DefaultResolveTTL.
	ResolveTTL time.Duration

	mu       sync.Mutex
	cache    map[string]*bundle.Bundle
	resolved map[string]resolution
}

type resolution struct {
	digest, keyID string
	found         bool
	at            time.Time
}

func (s *BundleStore) trusts(keyID string) bool {
	if keyID == "" {
		return s.AllowUnsigned
	}
	return slices.ContainsFunc(s.Trusted, func(k ed25519.PublicKey) bool { return bundle.KeyID(k) == keyID })
}

func (s *BundleStore) row(ctx context.Context, name, version string) (resolution, error) {
	ttl := s.ResolveTTL
	if ttl <= 0 {
		ttl = DefaultResolveTTL
	}
	nv := name + "\x00" + version
	s.mu.Lock()
	r, ok := s.resolved[nv]
	s.mu.Unlock()
	if ok && time.Since(r.at) < ttl {
		return r, nil
	}
	r = resolution{at: time.Now()}
	err := s.Pool.QueryRow(ctx, `
		select digest, key_id from plugin_bundles
		where name = $1 and version = $2
		order by key_id = '' limit 1`, name, version).Scan(&r.digest, &r.keyID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return r, fmt.Errorf("resolving the bundle for %s %s: %w", name, version, err)
	default:
		r.found = true
	}
	s.mu.Lock()
	if s.resolved == nil {
		s.resolved = map[string]resolution{}
	}
	s.resolved[nv] = r
	s.mu.Unlock()
	return r, nil
}

// Stored returns the verified stored bundle for name and version, nil with no
// error when no row exists, or ErrBundleUntrusted when one exists but this
// instance does not trust it now.
func (s *BundleStore) Stored(ctx context.Context, name, version string) (*bundle.Bundle, error) {
	if s == nil || s.Pool == nil {
		return nil, nil
	}
	r, err := s.row(ctx, name, version)
	if err != nil || !r.found {
		return nil, err
	}
	if !s.trusts(r.keyID) {
		return nil, fmt.Errorf("%s %s: %w", name, version, ErrBundleUntrusted)
	}
	key := r.digest + "/" + r.keyID
	s.mu.Lock()
	b, ok := s.cache[key]
	s.mu.Unlock()
	if ok {
		return b, nil
	}
	var archive []byte
	if err := s.Pool.QueryRow(ctx, `select archive from plugin_bundles where digest = $1 and key_id = $2`,
		r.digest, r.keyID).Scan(&archive); err != nil {
		return nil, fmt.Errorf("reading bundle %s: %w", r.digest, err)
	}
	b, err = bundle.Verify(bytes.NewReader(archive), s.Trusted, s.AllowUnsigned)
	if err != nil || b.Digest != r.digest || b.KeyID != r.keyID {
		return nil, fmt.Errorf("%s %s: %w (%v)", name, version, ErrBundleUntrusted, err)
	}
	s.mu.Lock()
	if s.cache == nil {
		s.cache = map[string]*bundle.Bundle{}
	}
	s.cache[key] = b
	s.mu.Unlock()
	return b, nil
}

// Resolve implements Bundles: the identity of what name and version would run
// now, without loading it.
func (s *BundleStore) Resolve(ctx context.Context, name, version string) (string, error) {
	if s.Pool != nil {
		r, err := s.row(ctx, name, version)
		if err != nil {
			return "", err
		}
		if r.found {
			if !s.trusts(r.keyID) {
				return "", fmt.Errorf("%s %s: %w", name, version, ErrBundleUntrusted)
			}
			return r.digest + "/" + r.keyID, nil
		}
	}
	if s.Dir == "" {
		return "", fmt.Errorf("no stored bundle for %s %s and no PLUGIN_DIR: %w", name, version, ErrNoBundle)
	}
	return "file:" + name + "@" + version, nil
}

// Load implements Bundles: a stored bundle's wasm, else the legacy loose
// "<name>-<version>.wasm" in Dir.
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
	s.WarnLoose(name, version, "wasm")
	return DirBundles(s.Dir).Load(ctx, name, version)
}

// WarnLoose logs a read of an unsigned, legacy loose file.
func (s *BundleStore) WarnLoose(name, version, what string) {
	log := s.Log
	if log == nil {
		log = slog.Default()
	}
	log.Warn("serving an unsigned loose plugin file from PLUGIN_DIR; package it as a signed .parley bundle",
		"name", name, "version", version, "file", what)
}

// Insert verifies archive against this store's trust set and stores it. The
// same bundle again is not an error; a different bundle for a name and
// version already held is ErrBundleConflict. uploadedBy is nil for a boot
// import.
func (s *BundleStore) Insert(ctx context.Context, archive []byte, uploadedBy *string) (*bundle.Bundle, error) {
	b, err := bundle.Verify(bytes.NewReader(archive), s.Trusted, s.AllowUnsigned)
	if err != nil {
		return nil, err
	}
	var m struct{ Name, Version string }
	if err := json.Unmarshal(b.Manifest, &m); err != nil || m.Name == "" || m.Version == "" {
		return nil, fmt.Errorf("bundle %s: the manifest names no name and version", b.Digest)
	}
	// An unsigned bundle is only stored where nothing is; a signed one is
	// held to one per name and version by the partial unique index.
	tag, err := s.Pool.Exec(ctx, `
		insert into plugin_bundles (digest, key_id, name, version, archive, manifest, wasm, ui, slots, uploaded_by)
		select $1, $2::text, $3::text, $4::text, $5::bytea, $6::jsonb, $7::bytea, $8::bytea, $9::bytea, $10::uuid
		where $2::text <> '' or not exists (select 1 from plugin_bundles where name = $3::text and version = $4::text)
		on conflict do nothing`,
		b.Digest, b.KeyID, m.Name, m.Version, archive, string(b.Manifest), b.Wasm, b.UI, b.Slots, uploadedBy)
	if err != nil {
		return nil, fmt.Errorf("storing bundle %s: %w", b.Digest, err)
	}
	if tag.RowsAffected() == 0 {
		var same bool
		if err := s.Pool.QueryRow(ctx, `select exists (select 1 from plugin_bundles where digest = $1 and key_id = $2)`,
			b.Digest, b.KeyID).Scan(&same); err != nil {
			return nil, fmt.Errorf("storing bundle %s: %w", b.Digest, err)
		}
		if !same {
			return nil, fmt.Errorf("%s %s: %w", m.Name, m.Version, ErrBundleConflict)
		}
	}
	return b, nil
}

// Import stores every *.parley file in Dir that verifies. A refused,
// conflicting or unreadable file is logged and skipped, never fatal.
// Concurrent imports from several replicas are safe.
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
		archive, err := readCapped(path)
		if err != nil {
			log.Warn("could not read a plugin bundle", "file", path, "error", err)
			continue
		}
		b, err := s.Insert(ctx, archive, nil)
		if errors.Is(err, ErrBundleConflict) {
			log.Error("refused a plugin bundle: another publisher's bundle already holds its name and version", "file", path, "error", err)
			continue
		}
		if err != nil {
			log.Warn("refused a plugin bundle", "file", path, "error", err)
			continue
		}
		log.Info("imported a plugin bundle", "file", path, "digest", b.Digest, "key_id", b.KeyID)
	}
}

func readCapped(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, bundle.MaxUpload+1))
	if err != nil {
		return nil, err
	}
	if len(data) > bundle.MaxUpload {
		return nil, bundle.ErrTooLarge
	}
	return data, nil
}
