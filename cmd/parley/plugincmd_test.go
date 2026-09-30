package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginVerifyAcceptsTheGoldenBundleOnlyWithItsKey(t *testing.T) {
	file := filepath.Join("..", "..", "sdk", "abi", "bundle-v1", "expected.parley")
	var out, errb bytes.Buffer
	if code := runPlugin([]string{"verify", file}, &out, &errb); code != 1 || !strings.Contains(errb.String(), "does not trust") {
		t.Fatalf("no key: exit %d, %s", code, errb.String())
	}
	dir := t.TempDir()
	out.Reset()
	if code := runPlugin([]string{"keygen", filepath.Join(dir, "k")}, &out, &errb); code != 0 || !strings.Contains(out.String(), "key id:") {
		t.Fatalf("keygen: exit %d, %s", code, errb.String())
	}
	out.Reset()
	if code := runPlugin([]string{"verify", "-key", goldenPub, file}, &out, &errb); code != 0 || !strings.Contains(out.String(), "digest: c17aa8ac") {
		t.Fatalf("verify: exit %d, %s %s", code, out.String(), errb.String())
	}
}

// The public half of sdk/abi/bundle-v1/TEST-ONLY-signing.key.
const goldenPub = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="

func TestPluginKeygenRefusesToOverwriteEitherFile(t *testing.T) {
	for _, existing := range []string{".key", ".pub"} {
		t.Run(existing, func(t *testing.T) {
			prefix := filepath.Join(t.TempDir(), "k")
			if err := os.WriteFile(prefix+existing, []byte("keep me"), 0o644); err != nil {
				t.Fatal(err)
			}
			var out, errb bytes.Buffer
			if code := runPlugin([]string{"keygen", prefix}, &out, &errb); code == 0 {
				t.Fatal("keygen overwrote an existing file")
			}
			if b, _ := os.ReadFile(prefix + existing); string(b) != "keep me" {
				t.Fatalf("existing %s changed to %q", existing, b)
			}
			other := map[string]string{".key": ".pub", ".pub": ".key"}[existing]
			if _, err := os.Stat(prefix + other); !os.IsNotExist(err) {
				t.Fatalf("keygen left an orphan %s", other)
			}
		})
	}
}

func TestPluginKeygenWritesThePrivateKeyOwnerOnly(t *testing.T) {
	prefix := filepath.Join(t.TempDir(), "k")
	var out, errb bytes.Buffer
	if code := runPlugin([]string{"keygen", prefix}, &out, &errb); code != 0 {
		t.Fatal(errb.String())
	}
	st, err := os.Stat(prefix + ".key")
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", st.Mode(), err)
	}
	if !strings.Contains(out.String(), "parley plugin verify -key") || strings.Contains(out.String(), "PLUGIN_TRUSTED_KEYS") {
		t.Fatalf("output: %s", out.String())
	}
}

// A failed private-key write must not leave the public half behind.
func TestKeygenRemovesThePublicKeyWhenThePrivateWriteFails(t *testing.T) {
	prefix := filepath.Join(t.TempDir(), "k")
	orig := writeKey
	writeKey = func(path, body string, mode os.FileMode) error {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		return writeNew(path, body, mode) // a directory at the .key path
	}
	t.Cleanup(func() { writeKey = orig })
	var out, errb bytes.Buffer
	if code := runPlugin([]string{"keygen", prefix}, &out, &errb); code == 0 {
		t.Fatal("keygen succeeded with a directory at the .key path")
	}
	if _, err := os.Lstat(prefix + ".pub"); !os.IsNotExist(err) {
		t.Fatalf("keygen left %s.pub behind: %v", prefix, err)
	}
}
