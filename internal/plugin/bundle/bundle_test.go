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

func goldenInputs(t *testing.T, dir string) (map[string][]byte, []byte) {
	t.Helper()
	files := map[string][]byte{}
	for _, n := range []string{"plugin.wasm", "ui.js", "slots.json"} {
		b, err := os.ReadFile(filepath.Join(dir, "input", n))
		if os.IsNotExist(err) && n != "plugin.wasm" {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		files[n] = b
	}
	m, err := os.ReadFile(filepath.Join(dir, "input", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	return files, m
}

// The digests are written out in full so a change to the format cannot pass
// by regenerating the vectors alongside it.
var goldenVectors = []struct{ dir, digest string }{
	{golden, "c17aa8ac55e0b548cee4fefbc91f2e9362b92f5933d2c7727b127c70a7d4ff1d"},
	{filepath.Join(golden, "large"), "8fb6eefc4e20fef462a179f2915f9450c043c4f40b962f24c7112ad0689f9f18"},
}

func TestPackReproducesTheGoldenVector(t *testing.T) {
	key := goldenKey(t)
	pub := key.Public().(ed25519.PublicKey)
	for _, v := range goldenVectors {
		t.Run(v.dir, func(t *testing.T) {
			files, m := goldenInputs(t, v.dir)
			got, err := Pack(files, m, key)
			if err != nil {
				t.Fatal(err)
			}
			if *update {
				os.WriteFile(filepath.Join(v.dir, "expected.parley"), got, 0o644)
			}
			want, err := os.ReadFile(filepath.Join(v.dir, "expected.parley"))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("Pack output differs from %s/expected.parley", v.dir)
			}
			b, err := Verify(bytes.NewReader(want), []ed25519.PublicKey{pub}, false)
			if err != nil {
				t.Fatal(err)
			}
			if *update {
				os.WriteFile(filepath.Join(v.dir, "expected.digest"), []byte(b.Digest+"\n"), 0o644)
			}
			if b.Digest != v.digest {
				t.Fatalf("digest %s, want %s", b.Digest, v.digest)
			}
			onDisk, _ := os.ReadFile(filepath.Join(v.dir, "expected.digest"))
			if string(onDisk) != v.digest+"\n" {
				t.Fatalf("expected.digest reads %q", onDisk)
			}
			if b.KeyID != KeyID(pub) || b.KeyID != "56475aa75463474c" {
				t.Fatalf("key id %s", b.KeyID)
			}
			if string(b.Wasm) != string(files["plugin.wasm"]) || string(b.UI) != string(files["ui.js"]) || string(b.Slots) != string(files["slots.json"]) || string(b.Manifest) != string(m) {
				t.Fatal("verified contents differ from the inputs")
			}
		})
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
		// 8 MiB each: the declared sizes stay within the cap, and only the
		// headers and end blocks carry the stream past it.
		tw.WriteHeader(&tar.Header{Name: n, Typeflag: tar.TypeReg, Size: 8 << 20})
		tw.Write(make([]byte, 8<<20))
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

// signedWith builds a bundle from explicit MANIFEST.sha256 bytes and entries.
func signedWith(t *testing.T, sumsBody []byte, es ...entry) []byte {
	t.Helper()
	sig := append(append([]byte{}, testPub...), ed25519.Sign(testKey, append([]byte(sigContext), sumsBody...))...)
	return raw(t, append([]entry{{name: "MANIFEST.sha256", body: sumsBody}, {name: "MANIFEST.sig", body: sig}}, es...)...)
}

var (
	mBody = []byte("{}")
	wBody = []byte("w")
	mSum  = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
	wSum  = "50e721e49c013f00c62cf59f2163542a9d8df02464efeb615d31051b0fddc326"
)

func TestRefusesNonCanonicalSums(t *testing.T) {
	es := []entry{{name: "manifest.json", body: mBody}, {name: "plugin.wasm", body: wBody}}
	cases := map[string]string{
		"unsorted":         wSum + "  plugin.wasm\n" + mSum + "  manifest.json\n",
		"uppercase":        strings.ToUpper(mSum) + "  manifest.json\n" + wSum + "  plugin.wasm\n",
		"no final newline": mSum + "  manifest.json\n" + wSum + "  plugin.wasm",
		"one space":        mSum + " manifest.json\n" + wSum + "  plugin.wasm\n",
		"blank line":       mSum + "  manifest.json\n\n" + wSum + "  plugin.wasm\n",
		"crlf":             mSum + "  manifest.json\r\n" + wSum + "  plugin.wasm\r\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) { refuse(t, signedWith(t, []byte(body), es...), ErrMalformed) })
	}
}

func TestRefusesADuplicateSumsLine(t *testing.T) {
	body := mSum + "  manifest.json\n" + mSum + "  manifest.json\n" + wSum + "  plugin.wasm\n"
	refuse(t, signedWith(t, []byte(body), entry{name: "manifest.json", body: mBody}, entry{name: "plugin.wasm", body: wBody}), ErrDuplicate)
}

func TestRefusesManifestJSONAndPackageJSONTogether(t *testing.T) {
	body := mSum + "  manifest.json\n" + mSum + "  package.json\n" + wSum + "  plugin.wasm\n"
	refuse(t, signedWith(t, []byte(body), entry{name: "manifest.json", body: mBody}, entry{name: "package.json", body: mBody}, entry{name: "plugin.wasm", body: wBody}), ErrDuplicate)
}

func TestRefusesAnUnknownFileName(t *testing.T) {
	refuse(t, valid(t, testKey, entry{name: "evil.sh", body: []byte("x")}), ErrUnknownFile)
}

func TestRefusesATruncatedSignature(t *testing.T) {
	body := []byte(mSum + "  manifest.json\n" + wSum + "  plugin.wasm\n")
	sig := append(append([]byte{}, testPub...), ed25519.Sign(testKey, append([]byte(sigContext), body...))...)
	for _, n := range []int{95, 10} { // 10 is shorter than the public key it would be sliced for
		refuse(t, raw(t, entry{name: "MANIFEST.sha256", body: body}, entry{name: "MANIFEST.sig", body: sig[:n]},
			entry{name: "manifest.json", body: mBody}, entry{name: "plugin.wasm", body: wBody}), ErrBadSignature)
	}
}

func TestRefusesATrailingGzipMember(t *testing.T) {
	data := valid(t, testKey)
	var extra bytes.Buffer
	gz := gzip.NewWriter(&extra)
	gz.Write([]byte("more"))
	gz.Close()
	refuse(t, append(data, extra.Bytes()...), ErrMalformed)
	refuse(t, append(valid(t, testKey), 0), ErrMalformed)
}

// Declared sizes are capped as a sum, not only as bytes read: a sparse entry
// expands to its declared size without the stream carrying it.
func TestRefusesDeclaredSizesPastTheCap(t *testing.T) {
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "slots.json", Typeflag: tar.TypeReg, Size: 9 << 20})
	tw.Write(make([]byte, 9<<20))
	tw.WriteHeader(&tar.Header{Name: "ui.js", Typeflag: tar.TypeReg, Size: 9 << 20})
	tw.Flush()
	gz.Close() // the second entry's content never arrives
	refuse(t, out.Bytes(), ErrTooLarge)
}

func TestPackEnforcesTheVerifyLimits(t *testing.T) {
	if _, err := Pack(map[string][]byte{"plugin.wasm": make([]byte, MaxWasm+1)}, mBody, nil); !errors.Is(err, ErrWasmTooLarge) {
		t.Fatalf("wasm: %v", err)
	}
	big := map[string][]byte{"plugin.wasm": make([]byte, MaxWasm), "ui.js": make([]byte, 7<<20)}
	if _, err := Pack(big, mBody, nil); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("total: %v", err)
	}
}
