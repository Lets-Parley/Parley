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
	// ErrBundleIdentity is a verified bundle whose manifest names no name
	// or no version, so it cannot be stored under one.
	ErrBundleIdentity = errors.New("the bundle's manifest names no name and version")
	// ErrBundleUntrusted is a stored bundle this instance does not trust now.
	ErrBundleUntrusted = errors.New("the stored bundle for this name and version is not trusted by this instance")
)

// DefaultResolveTTL is how long a pod reuses which row answers a name and
// version before asking the table again. It also spaces out the warning a
// loose-file read logs.
const DefaultResolveTTL = 5 * time.Second

// maxVerifiedBundles bounds the per-pod cache of verified bundles.
const maxVerifiedBundles = 64

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
// Verified bundles are cached by digest and key id, least recently used out
// past maxVerifiedBundles; their bytes never change.
//
// A row whose key is later removed from the trust set keeps its name and
// version: it is refused, not replaced, so republishing under a rotated key
// needs a new version.
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
	lru      []string // cache keys, least recently used first
	resolved map[string]resolution
	warned   map[string]time.Time
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

func (s *BundleStore) ttl() time.Duration {
	if s.ResolveTTL > 0 {
		return s.ResolveTTL
	}
	return DefaultResolveTTL
}

func (s *BundleStore) row(ctx context.Context, name, version string) (resolution, error) {
	nv := name + "\x00" + version
	s.mu.Lock()
	r, ok := s.resolved[nv]
	s.mu.Unlock()
	if ok && time.Since(r.at) < s.ttl() {
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
	// Only a found row is remembered: a name that exists nowhere is attacker
	// choosable on the public frame route, and caching it would grow without
	// bound.
	if !r.found {
		return r, nil
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
	return s.verified(ctx, r, name, version)
}

// verified is the bundle a found row names, only if its archive verifies
// under the trust set held now and its own manifest names the requested name
// and version: the columns are an index, and a relabelled row is refused.
func (s *BundleStore) verified(ctx context.Context, r resolution, name, version string) (*bundle.Bundle, error) {
	if !s.trusts(r.keyID) {
		return nil, fmt.Errorf("%s %s: %w", name, version, ErrBundleUntrusted)
	}
	key := r.digest + "/" + r.keyID
	s.mu.Lock()
	b, ok := s.cache[key]
	if ok {
		s.lru = append(removeString(s.lru, key), key)
	}
	s.mu.Unlock()
	if !ok {
		var archive []byte
		if err := s.Pool.QueryRow(ctx, `select archive from plugin_bundles where digest = $1 and key_id = $2`,
			r.digest, r.keyID).Scan(&archive); err != nil {
			return nil, fmt.Errorf("reading bundle %s: %w", r.digest, err)
		}
		var err error
		b, err = bundle.Verify(bytes.NewReader(archive), s.Trusted, s.AllowUnsigned)
		if err != nil || b.Digest != r.digest || b.KeyID != r.keyID {
			return nil, fmt.Errorf("%s %s: %w (%v)", name, version, ErrBundleUntrusted, err)
		}
		s.mu.Lock()
		if s.cache == nil {
			s.cache = map[string]*bundle.Bundle{}
		}
		s.cache[key] = b
		s.lru = append(removeString(s.lru, key), key)
		for len(s.lru) > maxVerifiedBundles {
			delete(s.cache, s.lru[0])
			s.lru = s.lru[1:]
		}
		s.mu.Unlock()
	}
	if n, v, err := manifestNameVersion(b.Manifest); err != nil || n != name || v != version {
		return nil, fmt.Errorf("%s %s: the stored bundle's manifest names another plugin: %w", name, version, ErrBundleUntrusted)
	}
	return b, nil
}

func manifestNameVersion(manifest []byte) (string, string, error) {
	var m struct{ Name, Version string }
	if err := json.Unmarshal(manifest, &m); err != nil || m.Name == "" || m.Version == "" {
		return "", "", errors.New("the manifest names no name and version")
	}
	return m.Name, m.Version, nil
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

// Load implements Bundles: a stored bundle's wasm and its identity, else the
// legacy loose "<name>-<version>.wasm" in Dir. One resolution answers both,
// so the bytes are always the ones the key names.
func (s *BundleStore) Load(ctx context.Context, name, version string) ([]byte, string, error) {
	if s.Pool != nil {
		r, err := s.row(ctx, name, version)
		if err != nil {
			return nil, "", err
		}
		if r.found {
			b, err := s.verified(ctx, r, name, version)
			if err != nil {
				return nil, "", err
			}
			return b.Wasm, r.digest + "/" + r.keyID, nil
		}
	}
	if s.Dir == "" {
		return nil, "", fmt.Errorf("no stored bundle for %s %s and no PLUGIN_DIR: %w", name, version, ErrNoBundle)
	}
	wasm, key, err := DirBundles(s.Dir).Load(ctx, name, version)
	if err == nil {
		s.WarnLoose(name, version, "wasm")
	}
	return wasm, key, err
}

// WarnLoose logs a read of an unsigned, legacy loose file, at most once per
// name and version per ResolveTTL on this pod. Call it only once the file has
// been read, so its keys are bounded by the files that exist.
func (s *BundleStore) WarnLoose(name, version, what string) {
	nv := name + "\x00" + version
	s.mu.Lock()
	if last, ok := s.warned[nv]; ok && time.Since(last) < s.ttl() {
		s.mu.Unlock()
		return
	}
	if s.warned == nil {
		s.warned = map[string]time.Time{}
	}
	s.warned[nv] = time.Now()
	s.mu.Unlock()
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
	b, _, err := s.Add(ctx, archive, uploadedBy)
	return b, err
}

// Add is Insert that also reports whether this call stored a new row, false
// when the same bundle was already held.
func (s *BundleStore) Add(ctx context.Context, archive []byte, uploadedBy *string) (*bundle.Bundle, bool, error) {
	if len(archive) > bundle.MaxUpload {
		return nil, false, bundle.ErrTooLarge
	}
	b, err := bundle.Verify(bytes.NewReader(archive), s.Trusted, s.AllowUnsigned)
	if err != nil {
		return nil, false, err
	}
	var m struct{ Name, Version string }
	if m.Name, m.Version, err = manifestNameVersion(b.Manifest); err != nil {
		return nil, false, fmt.Errorf("bundle %s: %w", b.Digest, ErrBundleIdentity)
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
		return nil, false, fmt.Errorf("storing bundle %s: %w", b.Digest, err)
	}
	if tag.RowsAffected() == 0 {
		var same bool
		if err := s.Pool.QueryRow(ctx, `select exists (select 1 from plugin_bundles where digest = $1 and key_id = $2)`,
			b.Digest, b.KeyID).Scan(&same); err != nil {
			return nil, false, fmt.Errorf("storing bundle %s: %w", b.Digest, err)
		}
		if !same {
			return nil, false, fmt.Errorf("%s %s: %w", m.Name, m.Version, ErrBundleConflict)
		}
	}
	return b, tag.RowsAffected() > 0, nil
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
