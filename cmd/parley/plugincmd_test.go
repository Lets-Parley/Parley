package main

import (
	"bytes"
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
