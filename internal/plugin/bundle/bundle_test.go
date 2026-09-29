package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden vectors in sdk/abi/bundle-v1")

const golden = "../../../sdk/abi/bundle-v1"

func goldenKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(golden, "TEST-ONLY-signing.key"))
	if err != nil {
		t.Fatal(err)
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func goldenInputs(t *testing.T) (map[string][]byte, []byte) {
	t.Helper()
	files := map[string][]byte{}
	for _, n := range []string{"plugin.wasm", "ui.js", "slots.json"} {
		b, err := os.ReadFile(filepath.Join(golden, "input", n))
		if err != nil {
			t.Fatal(err)
		}
		files[n] = b
	}
	m, err := os.ReadFile(filepath.Join(golden, "input", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	return files, m
}

func TestPackReproducesTheGoldenVector(t *testing.T) {
	key := goldenKey(t)
	files, m := goldenInputs(t)
	got, err := Pack(files, m, key)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Verify(bytes.NewReader(got), []ed25519.PublicKey{key.Public().(ed25519.PublicKey)}, false)
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		os.WriteFile(filepath.Join(golden, "expected.parley"), got, 0o644)
		os.WriteFile(filepath.Join(golden, "expected.digest"), []byte(b.Digest+"\n"), 0o644)
	}
	want, err := os.ReadFile(filepath.Join(golden, "expected.parley"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("Pack output differs from sdk/abi/bundle-v1/expected.parley")
	}
	wantDigest, _ := os.ReadFile(filepath.Join(golden, "expected.digest"))
	if b.Digest != strings.TrimSpace(string(wantDigest)) {
		t.Fatalf("digest %s, golden %s", b.Digest, wantDigest)
	}
	if b.KeyID != "" && b.KeyID != KeyID(key.Public().(ed25519.PublicKey)) {
		t.Fatalf("key id %s", b.KeyID)
	}
	if string(b.Wasm) != string(files["plugin.wasm"]) || string(b.UI) != string(files["ui.js"]) || string(b.Slots) != string(files["slots.json"]) || string(b.Manifest) != string(m) {
		t.Fatal("verified contents differ from the inputs")
	}
}

var testKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
var testPub = testKey.Public().(ed25519.PublicKey)

type entry struct {
	name string
	body []byte
	typ  byte
	size int64 // header size when nonzero and body is nil
}

// raw builds a tar.gz with no validation at all, for hostile fixtures.
func raw(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		size := int64(len(e.body))
		if typ != tar.TypeReg {
			size = 0
		}
		h := &tar.Header{Name: e.name, Typeflag: typ, Size: size, Linkname: "x", Format: tar.FormatPAX}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		tw.Write(e.body)
	}
	tw.Close()
	gz.Close()
	return out.Bytes()
}

// valid returns the entries of a valid signed bundle plus extras.
func valid(t *testing.T, key ed25519.PrivateKey, extra ...entry) []byte {
	t.Helper()
	files := map[string][]byte{"manifest.json": []byte(`{"name":"x"}`), "plugin.wasm": []byte("\x00asm")}
	s := sums(files)
	es := []entry{{name: "MANIFEST.sha256", body: s}}
	if key != nil {
		sig := append(append([]byte{}, key.Public().(ed25519.PublicKey)...), ed25519.Sign(key, append([]byte(sigContext), s...))...)
		es = append(es, entry{name: "MANIFEST.sig", body: sig})
	}
	for n, b := range files {
		es = append(es, entry{name: n, body: b})
	}
	return raw(t, append(es, extra...)...)
}

func refuse(t *testing.T, data []byte, want error) {
	t.Helper()
	_, err := Verify(bytes.NewReader(data), []ed25519.PublicKey{testPub}, false)
	if !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
}

func TestAValidBundleVerifies(t *testing.T) {
	b, err := Verify(bytes.NewReader(valid(t, testKey)), []ed25519.PublicKey{testPub}, false)
	if err != nil {
		t.Fatal(err)
	}
	if b.KeyID != KeyID(testPub) || len(b.KeyID) != 16 {
		t.Fatalf("key id %q", b.KeyID)
	}
}

func TestLegacyPackageJSONIsAcceptedAsTheManifest(t *testing.T) {
	files := map[string][]byte{"package.json": []byte(`{"name":"old"}`), "plugin.wasm": []byte("w")}
	s := sums(files)
	sig := append(append([]byte{}, testPub...), ed25519.Sign(testKey, append([]byte(sigContext), s...))...)
	data := raw(t, entry{name: "MANIFEST.sha256", body: s}, entry{name: "MANIFEST.sig", body: sig},
		entry{name: "package.json", body: files["package.json"]}, entry{name: "plugin.wasm", body: files["plugin.wasm"]})
	b, err := Verify(bytes.NewReader(data), []ed25519.PublicKey{testPub}, false)
	if err != nil || string(b.Manifest) != `{"name":"old"}` {
		t.Fatalf("%v %s", err, b)
	}
}

func TestRefusesAnUnlistedFile(t *testing.T) {
	refuse(t, valid(t, testKey, entry{name: "ui.js", body: []byte("alert(1)")}), ErrUnlisted)
}

func TestRefusesAListedButMissingFile(t *testing.T) {
	files := map[string][]byte{"manifest.json": []byte("{}"), "plugin.wasm": []byte("w"), "ui.js": []byte("u")}
	s := sums(files)
	sig := append(append([]byte{}, testPub...), ed25519.Sign(testKey, append([]byte(sigContext), s...))...)
	refuse(t, raw(t, entry{name: "MANIFEST.sha256", body: s}, entry{name: "MANIFEST.sig", body: sig},
		entry{name: "manifest.json", body: files["manifest.json"]}, entry{name: "plugin.wasm", body: files["plugin.wasm"]}), ErrMissing)
}

func TestRefusesADigestMismatch(t *testing.T) {
	files := map[string][]byte{"manifest.json": []byte("{}"), "plugin.wasm": []byte("w")}
	s := sums(files)
	sig := append(append([]byte{}, testPub...), ed25519.Sign(testKey, append([]byte(sigContext), s...))...)
	refuse(t, raw(t, entry{name: "MANIFEST.sha256", body: s}, entry{name: "MANIFEST.sig", body: sig},
		entry{name: "manifest.json", body: files["manifest.json"]}, entry{name: "plugin.wasm", body: []byte("tampered")}), ErrDigestMismatch)
}

func TestRefusesPathComponents(t *testing.T) {
	for _, n := range []string{"../plugin.wasm", "/plugin.wasm", "..", "a/ui.js", `a\ui.js`} {
		t.Run(n, func(t *testing.T) { refuse(t, valid(t, testKey, entry{name: n, body: []byte("x")}), ErrPath) })
	}
}

func TestRefusesSymlinksAndOtherNonRegularEntries(t *testing.T) {
	for _, typ := range []byte{tar.TypeSymlink, tar.TypeLink, tar.TypeDir} {
		refuse(t, valid(t, testKey, entry{name: "ui.js", typ: typ}), ErrNotRegular)
	}
}

func TestRefusesADuplicateEntry(t *testing.T) {
	refuse(t, valid(t, testKey, entry{name: "plugin.wasm", body: []byte("\x00asm")}), ErrDuplicate)
}

func TestRefusesAnOversizedWasm(t *testing.T) {
	big := make([]byte, MaxWasm+1)
	refuse(t, raw(t, entry{name: "plugin.wasm", body: big}), ErrWasmTooLarge)
}

// A few KiB of gzip that inflates past the cap: the refusal has to come while
// streaming, before the whole thing is held in memory.
func TestRefusesAZipBombWhileStreaming(t *testing.T) {
	var body bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&body, gzip.BestCompression)
	tw := tar.NewWriter(gz)
	for _, n := range []string{"slots.json", "ui.js"} {
		tw.WriteHeader(&tar.Header{Name: n, Typeflag: tar.TypeReg, Size: 9 << 20})
		tw.Write(make([]byte, 9<<20))
	}
	tw.Close()
	gz.Close()
	if body.Len() > 1<<20 {
		t.Fatalf("fixture is not a bomb: %d bytes", body.Len())
	}
	refuse(t, body.Bytes(), ErrTooLarge)
}

func TestRefusesABadSignature(t *testing.T) {
	files := map[string][]byte{"manifest.json": []byte(`{"name":"x"}`), "plugin.wasm": []byte("\x00asm")}
	s := sums(files)
	sig := append(append([]byte{}, testPub...), ed25519.Sign(testKey, []byte("some other message"))...)
	refuse(t, raw(t, entry{name: "MANIFEST.sha256", body: s}, entry{name: "MANIFEST.sig", body: sig},
		entry{name: "manifest.json", body: files["manifest.json"]}, entry{name: "plugin.wasm", body: files["plugin.wasm"]}), ErrBadSignature)
}

func TestRefusesAnUntrustedKey(t *testing.T) {
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, 32))
	refuse(t, valid(t, other), ErrUntrustedKey)
}

func TestRefusesUnsignedUnlessAllowed(t *testing.T) {
	data := valid(t, nil)
	refuse(t, data, ErrUnsigned)
	b, err := Verify(bytes.NewReader(data), nil, true)
	if err != nil || b.KeyID != "" {
		t.Fatalf("allowUnsigned: %v", err)
	}
}
