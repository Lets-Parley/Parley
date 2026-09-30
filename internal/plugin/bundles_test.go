package plugin

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"testing"

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
	pub := key.Public().(ed25519.PublicKey)
	b, err := bundle.Verify(bytes.NewReader(packed(t, name, wasm, key)), []ed25519.PublicKey{pub}, false)
	if err != nil {
		t.Fatal(err)
	}
	s := &BundleStore{Pool: pool, Trusted: []ed25519.PublicKey{pub}}
	if err := s.Insert(context.Background(), b, nil); err != nil {
		t.Fatal(err)
	}
	return s, b
}

func TestTwoHostsOnOneDatabaseLoadIdenticalBytes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	wasm := guestPanicExporting("on_job")
	first, stored := storedBundle(t, pool, name, wasm)
	second := &BundleStore{Pool: pool, Trusted: first.Trusted}
	// A second replica importing the same bundle is not an error.
	if err := second.Insert(ctx, stored, nil); err != nil {
		t.Fatalf("a second insert of the same bundle failed: %v", err)
	}
	a, err := first.Load(ctx, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	b, err := second.Load(ctx, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, wasm) || !bytes.Equal(b, wasm) {
		t.Fatal("two stores on one database did not both load the stored wasm")
	}
}

// A hit still resolves the digest, but the bytes come from memory: rewriting
// the row behind the store's back does not change what it serves.
func TestACacheHitDoesNotReadTheBytesAgain(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	s, b := storedBundle(t, pool, name, []byte("\x00asm-original"))
	if _, err := s.Load(ctx, name, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update plugin_bundles set wasm = 'changed' where digest = $1`, b.Digest); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load(ctx, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x00asm-original" {
		t.Fatalf("a cache hit re-read the bytes from the table: %q", got)
	}
}

// A row outranks the directory, and the directory answers only when there is
// no row this instance trusts.
func TestAStoredBundleIsPreferredOverTheDirectory(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	s, _ := storedBundle(t, pool, name, []byte("from-table"))
	s.Dir = t.TempDir()
	if err := os.WriteFile(filepath.Join(s.Dir, name+"-1.0.0.wasm"), []byte("from-disk"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Load(ctx, name, "1.0.0"); string(got) != "from-table" {
		t.Fatalf("got %q, want the stored bundle", got)
	}
	untrusting := &BundleStore{Pool: pool, Dir: s.Dir}
	if got, _ := untrusting.Load(ctx, name, "1.0.0"); string(got) != "from-disk" {
		t.Fatalf("a store that trusts no key served %q; want the directory's file", got)
	}
}

// An unsigned row is served only while PLUGIN_ALLOW_UNSIGNED is on.
func TestAnUnsignedRowIsNotServedByDefault(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	name := uniqueName(t)
	b, err := bundle.Verify(bytes.NewReader(packed(t, name, []byte("unsigned"), nil)), nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&BundleStore{Pool: pool}).Insert(ctx, b, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := (&BundleStore{Pool: pool}).Stored(ctx, name, "1.0.0"); got != nil {
		t.Fatal("an unsigned bundle was served with PLUGIN_ALLOW_UNSIGNED off")
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

	s := &BundleStore{Pool: pool, Dir: dir, Trusted: []ed25519.PublicKey{trusted.Public().(ed25519.PublicKey)}}
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

func uniqueName(t *testing.T) string {
	installNo++
	return fmt.Sprintf("bundle-%d-%d", installNo, os.Getpid()) + "-" + filepath.Base(t.TempDir())
}
