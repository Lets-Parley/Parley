package plugin

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin/bundle"
)

func testKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv
}

func pubOf(k ed25519.PrivateKey) ed25519.PublicKey { return k.Public().(ed25519.PublicKey) }

// packed is a .parley for name@1.0.0, signed by key or unsigned when key is nil.
func packed(t *testing.T, name string, wasm []byte, key ed25519.PrivateKey) []byte {
	t.Helper()
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": wasm, "ui.js": []byte("//ui " + name)},
		[]byte(fmt.Sprintf(`{"name":%q,"version":"1.0.0"}`, name)), key)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// storedBundle inserts a signed bundle for name@1.0.0 and returns a store
// that trusts its key.
func storedBundle(t *testing.T, pool *pgxpool.Pool, name string, wasm []byte) (*BundleStore, *bundle.Bundle) {
	t.Helper()
	key := testKey(t)
	s := &BundleStore{Pool: pool, Trusted: []ed25519.PublicKey{pubOf(key)}, Log: quietLogger()}
	b, err := s.Insert(context.Background(), packed(t, name, wasm, key), nil)
	if err != nil {
		t.Fatal(err)
	}
	return s, b
}

// Two hosts, each with its own store, as two pods would be: both run the one
// stored bundle.
func TestTwoHostsOnOneDatabaseRunTheStoredBundle(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store)
	first, stored := storedBundle(t, store.Pool, in.Name, guestPanic())
	// AllowUnsigned, so the unsigned bundle passes Verify and it is the
	// insert's own guard that refuses it.
	second := &BundleStore{Pool: store.Pool, Trusted: first.Trusted, AllowUnsigned: true}
	if _, err := second.Insert(ctx, packed(t, in.Name, guestPanic(), nil), nil); !errors.Is(err, ErrBundleConflict) {
		t.Fatalf("an unsigned bundle beside a signed one: got %v, want ErrBundleConflict", err)
	}
	for _, s := range []*BundleStore{first, second} {
		h := NewHost(store, HostConfig{})
		h.Log = quietLogger()
		h.Bundles = s
		t.Cleanup(func() { h.Close(ctx) })
		if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestPanic) {
			t.Fatalf("got %v, want ErrGuestPanic from the stored bundle", err)
		}
		if got, _, _ := s.Load(ctx, in.Name, "1.0.0"); !bytes.Equal(got, stored.Wasm) {
			t.Fatal("a store loaded bytes other than the stored wasm")
		}
	}
}

// A hit never re-reads the archive; a fill always re-verifies it.
func TestTheArchiveIsVerifiedOnEveryFillAndNotReadOnAHit(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	s, b := storedBundle(t, pool, name, []byte("\x00asm-original"))
	if _, _, err := s.Load(ctx, name, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update plugin_bundles set archive = 'garbage' where digest = $1`, b.Digest); err != nil {
		t.Fatal(err)
	}
	if got, _, err := s.Load(ctx, name, "1.0.0"); err != nil || string(got) != "\x00asm-original" {
		t.Fatalf("a cache hit re-read the archive: %q, %v", got, err)
	}
	fresh := &BundleStore{Pool: pool, Trusted: s.Trusted}
	if _, _, err := fresh.Load(ctx, name, "1.0.0"); !errors.Is(err, ErrBundleUntrusted) {
		t.Fatalf("a fill served an archive that does not verify: %v", err)
	}
}

// key_id is an index, not authority: a row relabelled with another trusted
// key's id is refused, because the archive says who signed it.
func TestTheKeyIDColumnGrantsNothing(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	signer, b := storedBundle(t, pool, name, []byte("wasm"))
	other := testKey(t)
	if _, err := pool.Exec(ctx, `update plugin_bundles set key_id = $1 where digest = $2`, bundle.KeyID(pubOf(other)), b.Digest); err != nil {
		t.Fatal(err)
	}
	s := &BundleStore{Pool: pool, Trusted: append(signer.Trusted, pubOf(other))}
	if _, _, err := s.Load(ctx, name, "1.0.0"); !errors.Is(err, ErrBundleUntrusted) {
		t.Fatalf("a relabelled row was served: %v", err)
	}
}

// Revocation reaches a warm host on its next call: trust is re-checked on
// every resolve, and a refused resolve evicts the compiled module.
func TestARevokedKeyStopsAWarmHost(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store)
	s, _ := storedBundle(t, store.Pool, in.Name, guestPanic())
	h := NewHost(store, HostConfig{})
	h.Log = quietLogger()
	h.Bundles = s
	t.Cleanup(func() { h.Close(ctx) })
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("got %v before revocation", err)
	}
	s.Trusted = nil
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrBundleUntrusted) {
		t.Fatalf("a warm host ran a bundle whose key was revoked: %v", err)
	}
	if h.CachedModules() != 0 {
		t.Fatal("the revoked bundle's module is still resident")
	}
}

// When a bundle is stored for a name and version a host was running from a
// loose file, the host moves to it within ResolveTTL, so the wasm it runs and
// the UI the frame serves come from the same bundle.
func TestTheHostAndTheUIDoNotSkew(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store)
	key := testKey(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, in.Name+"-1.0.0.wasm"), guestNoop(), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &BundleStore{Pool: store.Pool, Dir: dir, Trusted: []ed25519.PublicKey{pubOf(key)}, Log: quietLogger(), ResolveTTL: time.Millisecond}
	h := NewHost(store, HostConfig{})
	h.Log = quietLogger()
	h.Bundles = s
	t.Cleanup(func() { h.Close(ctx) })
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); err != nil {
		t.Fatalf("the loose file did not run: %v", err)
	}
	if _, err := s.Insert(ctx, packed(t, in.Name, guestPanic(), key), nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := h.Call(ctx, in.ID, "run", nil, ModeAsync); !errors.Is(err, ErrGuestPanic) {
		t.Fatalf("the host kept running the loose file after a bundle was stored: %v", err)
	}
	b, err := s.Stored(ctx, in.Name, "1.0.0")
	if err != nil || b == nil || string(b.UI) != "//ui "+in.Name {
		t.Fatalf("the UI does not come from the bundle the host runs: %v", err)
	}
}

func TestOnePublisherPerNameAndVersion(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	first, second := testKey(t), testKey(t)
	s := &BundleStore{Pool: pool, Trusted: []ed25519.PublicKey{pubOf(first), pubOf(second)}, AllowUnsigned: true}

	name := uniqueName(t)
	if _, err := s.Insert(ctx, packed(t, name, []byte("a"), first), nil); err != nil {
		t.Fatal(err)
	}
	for what, archive := range map[string][]byte{
		"another signer":             packed(t, name, []byte("a"), second),
		"the same signer, new bytes": packed(t, name, []byte("b"), first),
		"an unsigned bundle":         packed(t, name, []byte("a"), nil),
	} {
		if _, err := s.Insert(ctx, archive, nil); !errors.Is(err, ErrBundleConflict) {
			t.Errorf("%s: got %v, want ErrBundleConflict", what, err)
		}
	}

	// An unsigned bundle that came first does not compete with a signed one.
	name = uniqueName(t)
	if _, err := s.Insert(ctx, packed(t, name, []byte("unsigned"), nil), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Insert(ctx, packed(t, name, []byte("signed"), first), nil); err != nil {
		t.Fatalf("a signed bundle was refused beside an unsigned one: %v", err)
	}
	if got, _, _ := s.Load(ctx, name, "1.0.0"); string(got) != "signed" {
		t.Fatalf("got %q, want the signed bundle", got)
	}
}

// A stored row for a name and version — trusted or not — is the whole answer:
// the loose file is read only when there is no row at all.
func TestTheLooseFileIsReadOnlyWhenNoRowExists(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	s, _ := storedBundle(t, pool, name, []byte("from-table"))
	dir := t.TempDir()
	for _, n := range []string{name, name + "-loose"} {
		if err := os.WriteFile(filepath.Join(dir, n+"-1.0.0.wasm"), []byte("from-disk"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s.Dir = dir
	if got, _, _ := s.Load(ctx, name, "1.0.0"); string(got) != "from-table" {
		t.Fatalf("got %q, want the stored bundle", got)
	}
	untrusting := &BundleStore{Pool: pool, Dir: dir, Log: quietLogger()}
	if got, _, err := untrusting.Load(ctx, name, "1.0.0"); !errors.Is(err, ErrBundleUntrusted) {
		t.Fatalf("an untrusted row fell back to the loose file: %q, %v", got, err)
	}
	if got, _, _ := untrusting.Load(ctx, name+"-loose", "1.0.0"); string(got) != "from-disk" {
		t.Fatalf("with no row the loose file was not read: %q", got)
	}
}

// An unsigned row is served only while PLUGIN_ALLOW_UNSIGNED is on.
func TestAnUnsignedRowIsNotServedByDefault(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	if _, err := (&BundleStore{Pool: pool, AllowUnsigned: true}).Insert(ctx, packed(t, name, []byte("unsigned"), nil), nil); err != nil {
		t.Fatal(err)
	}
	if got, err := (&BundleStore{Pool: pool}).Stored(ctx, name, "1.0.0"); got != nil || !errors.Is(err, ErrBundleUntrusted) {
		t.Fatalf("an unsigned bundle was served with PLUGIN_ALLOW_UNSIGNED off: %v", err)
	}
	if got, _ := (&BundleStore{Pool: pool, AllowUnsigned: true}).Stored(ctx, name, "1.0.0"); got == nil {
		t.Fatal("an unsigned bundle was not served with PLUGIN_ALLOW_UNSIGNED on")
	}
}

func TestImportIsIdempotentAndRefusesWhatItCannotTrust(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	dir := t.TempDir()
	trusted, stranger := testKey(t), testKey(t)
	good, untrusted, tampered, unsigned := uniqueName(t)+"-good", uniqueName(t)+"-untrusted", uniqueName(t)+"-tampered", uniqueName(t)+"-unsigned"

	bad := packed(t, tampered, []byte("wasm"), trusted)
	bad[len(bad)/2] ^= 0xff
	for file, body := range map[string][]byte{
		"good.parley":      packed(t, good, []byte("wasm"), trusted),
		"untrusted.parley": packed(t, untrusted, []byte("wasm"), stranger),
		"tampered.parley":  bad,
		"unsigned.parley":  packed(t, unsigned, []byte("wasm"), nil),
	} {
		if err := os.WriteFile(filepath.Join(dir, file), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	s := &BundleStore{Pool: pool, Dir: dir, Trusted: []ed25519.PublicKey{pubOf(trusted)}}
	s.Import(ctx, quietLogger())
	s.Import(ctx, quietLogger())
	for name, want := range map[string]int{good: 1, untrusted: 0, tampered: 0, unsigned: 0} {
		var n int
		if err := pool.QueryRow(ctx, `select count(*) from plugin_bundles where name = $1`, name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != want {
			t.Errorf("%s: %d rows after two imports, want %d", name, n, want)
		}
	}
}

// The manifest inside the archive names the plugin; the name and version
// columns are an index. A row relabelled to another name is refused, cached
// or not.
func TestARelabelledRowIsRefused(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	s, b := storedBundle(t, pool, name, []byte("wasm"))
	if _, err := s.Stored(ctx, name, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	other := name + "-relabelled"
	if _, err := pool.Exec(ctx, `update plugin_bundles set name = $1, version = '9.9.9' where digest = $2`, other, b.Digest); err != nil {
		t.Fatal(err)
	}
	for _, store := range []*BundleStore{s, {Pool: pool, Trusted: s.Trusted}} {
		if _, err := store.Stored(ctx, other, "9.9.9"); !errors.Is(err, ErrBundleUntrusted) {
			t.Fatalf("a relabelled row was served: %v", err)
		}
	}
}

func TestInsertRefusesAnArchiveOverTheUploadCap(t *testing.T) {
	s := &BundleStore{Pool: testPool(t)}
	if _, err := s.Insert(context.Background(), make([]byte, bundle.MaxUpload+1), nil); !errors.Is(err, bundle.ErrTooLarge) {
		t.Fatalf("got %v, want ErrTooLarge", err)
	}
}

func TestALooseReadWarnsOncePerTTL(t *testing.T) {
	var buf bytes.Buffer
	s := &BundleStore{Log: slog.New(slog.NewTextHandler(&buf, nil))}
	s.WarnLoose("demo", "1.0.0", "ui.js")
	s.WarnLoose("demo", "1.0.0", "ui.js")
	if n := strings.Count(buf.String(), "\n"); n != 1 {
		t.Fatalf("two loose reads logged %d lines, want 1", n)
	}
}

// Names nobody stored must leave nothing behind: on the public frame route
// they are the caller's to choose.
func TestUnknownNamesLeaveNoCacheOrWarningBehind(t *testing.T) {
	s := &BundleStore{Pool: testPool(t), Dir: t.TempDir(), Log: quietLogger()}
	ctx := context.Background()
	for i := range 1000 {
		name := fmt.Sprintf("nobody-%d-%d-%d", i, os.Getpid(), time.Now().UnixNano())
		if b, err := s.Stored(ctx, name, "1.0.0"); b != nil || err != nil {
			t.Fatalf("Stored(%s): %v, %v", name, b, err)
		}
		if _, _, err := s.Load(ctx, name, "1.0.0"); err == nil {
			t.Fatalf("Load(%s) found a file that does not exist", name)
		}
	}
	if len(s.resolved) != 0 || len(s.warned) != 0 {
		t.Fatalf("1000 unknown names left %d resolutions and %d warnings", len(s.resolved), len(s.warned))
	}
}

func uniqueName(t *testing.T) string {
	installNo++
	return fmt.Sprintf("bundle-%d-%d", installNo, os.Getpid()) + "-" + filepath.Base(t.TempDir())
}
