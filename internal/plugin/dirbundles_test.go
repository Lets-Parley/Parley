package plugin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A bundle path is operator input, so a name or version that could climb out
// of the directory is refused before a filename is even built.
func TestDirBundlesRefusesANameThatClimbsOutOfTheDirectory(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(filepath.Dir(dir), "escape-1.0.0.wasm")
	if err := os.WriteFile(outside, []byte("escaped"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(outside) })

	for _, path := range []string{"sub/escape-1.0.0.wasm", "demo-sub/escape.wasm"} {
		file := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("in the bundle directory"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	d := DirBundles(dir)
	for _, field := range []string{"../escape", "..", `..\escape`, "sub/escape", ""} {
		if _, _, err := d.Load(context.Background(), field, "1.0.0"); err == nil {
			t.Fatalf("name %q was accepted", field)
		}
		if _, _, err := d.Load(context.Background(), "demo", field); err == nil {
			t.Fatalf("version %q was accepted", field)
		}
	}

	if err := os.WriteFile(filepath.Join(dir, "demo-1.0.0.wasm"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.Load(context.Background(), "demo", "1.0.0"); err != nil {
		t.Fatalf("a legitimate bundle was refused: %v", err)
	}
}

// The string screen only ever looks at the name and version. A symlink
// planted inside the bundle directory, pointing outside it, resolves through
// a filename that passes the screen cleanly. os.ReadFile would follow that
// symlink; os.Root, which DirBundles.Load is now built on, refuses to,
// confining the read to the directory tree by construction rather than by
// pattern-matching the two fields.
func TestDirBundlesRefusesASymlinkThatEscapesTheDirectory(t *testing.T) {
	dir := t.TempDir()
	outsideDir := t.TempDir()
	outside := filepath.Join(outsideDir, "secret.wasm")
	if err := os.WriteFile(outside, []byte("escaped"), 0o600); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(dir, "demo-1.0.0.wasm")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable in this environment: %v", err)
	}

	for _, field := range []string{"demo", "1.0.0"} {
		if field == "" || strings.ContainsAny(field, `/\`) || strings.Contains(field, "..") {
			t.Fatalf("test setup is broken: %q would be caught by the string screen", field)
		}
	}

	d := DirBundles(dir)
	if _, _, err := d.Load(context.Background(), "demo", "1.0.0"); err == nil {
		t.Fatalf("a symlink inside the bundle directory was followed outside it")
	}

	if body, err := os.ReadFile(link); err != nil || string(body) != "escaped" {
		t.Fatalf("test setup is broken: a bare os.ReadFile did not follow the symlink (body=%q err=%v)", body, err)
	}
}

func TestDirBundlesHasUIConfinesSymlinkTargets(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "panel.js")
	for _, target := range []string{filepath.Join(dir, "panel.js"), outside} {
		if err := os.WriteFile(target, []byte("// fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("panel.js", filepath.Join(dir, "inside-1.0.0.ui.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "outside-1.0.0.ui.js")); err != nil {
		t.Fatal(err)
	}

	bundles := DirBundles(dir)
	if !bundles.HasUI("inside", "1.0.0") {
		t.Error("an in-directory UI symlink was refused")
	}
	if bundles.HasUI("outside", "1.0.0") {
		t.Error("an out-of-directory UI symlink was reported as available")
	}
}
