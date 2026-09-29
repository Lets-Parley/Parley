// Package bundle reads and writes the `.parley` plugin bundle, format v1.
//
// The format is specified in sdk/abi/bundle-v1.md. Verify is the only way a
// bundle's bytes become a Bundle: every refusal below happens before the
// caller sees any content, and the publisher is identified by the key that
// verified the signature, never by anything the bundle says about itself.
package bundle

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

const (
	// MaxWasm caps plugin.wasm.
	MaxWasm = 10 << 20
	// MaxTotal caps the uncompressed tar stream, headers included.
	MaxTotal = 16 << 20

	sigContext  = "parley-bundle-v1\n"
	sumsName    = "MANIFEST.sha256"
	sigName     = "MANIFEST.sig"
	wasmName    = "plugin.wasm"
	manifestNew = "manifest.json"
	manifestOld = "package.json"
)

// The files a bundle may carry besides MANIFEST.sha256 and MANIFEST.sig.
var payloadNames = map[string]bool{
	manifestNew: true, manifestOld: true, wasmName: true, "ui.js": true, "slots.json": true,
}

var (
	ErrUnlisted       = errors.New("bundle contains a file MANIFEST.sha256 does not list")
	ErrMissing        = errors.New("bundle is missing a file MANIFEST.sha256 lists")
	ErrDigestMismatch = errors.New("file does not match its MANIFEST.sha256 digest")
	ErrPath           = errors.New("bundle entry name is not a bare file name")
	ErrNotRegular     = errors.New("bundle entry is not a regular file")
	ErrDuplicate      = errors.New("bundle contains a file twice")
	ErrUnknownFile    = errors.New("bundle contains a file the format does not define")
	ErrWasmTooLarge   = errors.New("plugin.wasm exceeds 10 MiB")
	ErrTooLarge       = errors.New("bundle exceeds 16 MiB uncompressed")
	ErrBadSignature   = errors.New("bundle signature does not verify")
	ErrUntrustedKey   = errors.New("bundle is signed by a key this instance does not trust")
	ErrUnsigned       = errors.New("bundle is unsigned")
	ErrMalformed      = errors.New("bundle is malformed")
)

// Bundle is a verified bundle. KeyID is empty only for an unsigned bundle
// accepted under allowUnsigned. UI and Slots are nil when absent.
type Bundle struct {
	Digest   string
	KeyID    string
	Manifest []byte
	Wasm     []byte
	UI       []byte
	Slots    []byte
}

// KeyID is the first 8 bytes of sha256(pub), hex.
func KeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

// sums renders MANIFEST.sha256 for files, which must not include MANIFEST.*.
func sums(files map[string][]byte) []byte {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	var b bytes.Buffer
	for _, n := range names {
		sum := sha256.Sum256(files[n])
		fmt.Fprintf(&b, "%s  %s\n", hex.EncodeToString(sum[:]), n)
	}
	return b.Bytes()
}

// Pack writes a bundle of manifest (as manifest.json) plus files. A nil key
// writes an unsigned bundle. Output is deterministic for the same inputs.
func Pack(files map[string][]byte, manifest []byte, key ed25519.PrivateKey) ([]byte, error) {
	all := map[string][]byte{manifestNew: manifest}
	for n, body := range files {
		if !payloadNames[n] || n == manifestNew || n == manifestOld {
			return nil, fmt.Errorf("packing %q: %w", n, ErrUnknownFile)
		}
		all[n] = body
	}
	s := sums(all)
	entries := map[string][]byte{sumsName: s}
	for n, body := range all {
		entries[n] = body
	}
	if key != nil {
		pub := key.Public().(ed25519.PublicKey)
		entries[sigName] = append(append([]byte{}, pub...), ed25519.Sign(key, append([]byte(sigContext), s...))...)
	}
	names := make([]string, 0, len(entries))
	for n := range entries {
		names = append(names, n)
	}
	sort.Strings(names)

	var out bytes.Buffer
	gz, err := gzip.NewWriterLevel(&out, gzip.NoCompression)
	if err != nil {
		return nil, fmt.Errorf("packing bundle: %w", err)
	}
	tw := tar.NewWriter(gz)
	for _, n := range names {
		hdr := &tar.Header{Typeflag: tar.TypeReg, Name: n, Size: int64(len(entries[n])), ModTime: time.Unix(0, 0), Format: tar.FormatUSTAR}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, fmt.Errorf("packing %q: %w", n, err)
		}
		if _, err := tw.Write(entries[n]); err != nil {
			return nil, fmt.Errorf("packing %q: %w", n, err)
		}
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("packing bundle: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, fmt.Errorf("packing bundle: %w", err)
	}
	return out.Bytes(), nil
}

// capped refuses to yield more than n bytes of the decompressed stream, so a
// small upload cannot expand past MaxTotal however it is compressed.
type capped struct {
	r io.Reader
	n int64
}

func (c *capped) Read(p []byte) (int, error) {
	if c.n <= 0 {
		return 0, ErrTooLarge
	}
	if int64(len(p)) > c.n {
		p = p[:c.n]
	}
	k, err := c.r.Read(p)
	c.n -= int64(k)
	return k, err
}

// Verify unpacks r and returns the bundle only if every check passes.
func Verify(r io.Reader, trusted []ed25519.PublicKey, allowUnsigned bool) (*Bundle, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	tr := tar.NewReader(&capped{r: gz, n: MaxTotal})
	got := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			if errors.Is(err, ErrTooLarge) {
				return nil, ErrTooLarge
			}
			return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
		}
		n := hdr.Name
		if n == "" || n == "." || n == ".." || strings.ContainsAny(n, "/\\") {
			return nil, fmt.Errorf("%q: %w", n, ErrPath)
		}
		if hdr.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("%q: %w", n, ErrNotRegular)
		}
		if _, dup := got[n]; dup {
			return nil, fmt.Errorf("%q: %w", n, ErrDuplicate)
		}
		if !payloadNames[n] && n != sumsName && n != sigName {
			return nil, fmt.Errorf("%q: %w", n, ErrUnknownFile)
		}
		if n == wasmName && hdr.Size > MaxWasm {
			return nil, ErrWasmTooLarge
		}
		if hdr.Size > MaxTotal {
			return nil, ErrTooLarge
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			if errors.Is(err, ErrTooLarge) {
				return nil, ErrTooLarge
			}
			return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
		}
		got[n] = body
	}

	s, ok := got[sumsName]
	if !ok {
		return nil, fmt.Errorf("%s: %w", sumsName, ErrMissing)
	}
	listed := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(s))
	for sc.Scan() {
		sum, name, ok := strings.Cut(sc.Text(), "  ")
		if !ok || len(sum) != 64 || !payloadNames[name] {
			return nil, fmt.Errorf("%w: bad %s line %q", ErrMalformed, sumsName, sc.Text())
		}
		if _, dup := listed[name]; dup {
			return nil, fmt.Errorf("%q: %w", name, ErrDuplicate)
		}
		listed[name] = sum
	}
	for n := range got {
		if n != sumsName && n != sigName && listed[n] == "" {
			return nil, fmt.Errorf("%q: %w", n, ErrUnlisted)
		}
	}
	for n, want := range listed {
		body, ok := got[n]
		if !ok {
			return nil, fmt.Errorf("%q: %w", n, ErrMissing)
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != want {
			return nil, fmt.Errorf("%q: %w", n, ErrDigestMismatch)
		}
	}

	manifest, hasNew := got[manifestNew]
	if old, hasOld := got[manifestOld]; hasOld {
		if hasNew {
			return nil, fmt.Errorf("manifest.json and package.json: %w", ErrDuplicate)
		}
		manifest = old
	} else if !hasNew {
		return nil, fmt.Errorf("manifest.json: %w", ErrMissing)
	}
	if got[wasmName] == nil {
		return nil, fmt.Errorf("%s: %w", wasmName, ErrMissing)
	}

	b := &Bundle{Manifest: manifest, Wasm: got[wasmName], UI: got["ui.js"], Slots: got["slots.json"]}
	digest := sha256.Sum256(s)
	b.Digest = hex.EncodeToString(digest[:])

	sig, signed := got[sigName]
	if !signed {
		if !allowUnsigned {
			return nil, ErrUnsigned
		}
		return b, nil
	}
	if len(sig) != ed25519.PublicKeySize+ed25519.SignatureSize {
		return nil, ErrBadSignature
	}
	pub := ed25519.PublicKey(sig[:ed25519.PublicKeySize])
	if !ed25519.Verify(pub, append([]byte(sigContext), s...), sig[ed25519.PublicKeySize:]) {
		return nil, ErrBadSignature
	}
	for _, k := range trusted {
		if pub.Equal(k) {
			b.KeyID = KeyID(pub)
			return b, nil
		}
	}
	return nil, ErrUntrustedKey
}
