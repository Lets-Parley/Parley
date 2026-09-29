package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/lets-parley/parley/internal/plugin/bundle"
)

// runPlugin handles `parley plugin keygen|verify`. Packing and signing are the
// SDK's job; the server binary only makes keys and checks bundles.
func runPlugin(args []string, stdout, stderr io.Writer) int {
	usage := "usage: parley plugin keygen [path-prefix] | parley plugin verify [-key BASE64]... [-allow-unsigned] FILE"
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "keygen":
		prefix := "parley-plugin"
		if len(args) > 1 {
			prefix = args[1]
		}
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			fmt.Fprintln(stderr, "generating key:", err)
			return 1
		}
		pubB64 := base64.StdEncoding.EncodeToString(pub)
		for _, p := range []string{prefix + ".key", prefix + ".pub"} {
			if _, err := os.Lstat(p); err == nil {
				fmt.Fprintf(stderr, "refusing to overwrite %s\n", p)
				return 1
			}
		}
		if err := writeNew(prefix+".key", base64.StdEncoding.EncodeToString(priv.Seed())+"\n", 0o600); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if err := writeNew(prefix+".pub", pubB64+"\n", 0o644); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintf(stdout, "private key: %s.key (keep secret)\npublic key:  %s.pub\nkey id:      %s\ntrust it:    parley plugin verify -key %s FILE\n", prefix, prefix, bundle.KeyID(pub), pubB64)
		return 0
	case "verify":
		fs := flag.NewFlagSet("verify", flag.ContinueOnError)
		fs.SetOutput(stderr)
		var keys []ed25519.PublicKey
		fs.Func("key", "trusted base64 Ed25519 public key (repeatable)", func(s string) error {
			k, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
			if err != nil || len(k) != ed25519.PublicKeySize {
				return fmt.Errorf("not a base64 Ed25519 public key")
			}
			keys = append(keys, k)
			return nil
		})
		allowUnsigned := fs.Bool("allow-unsigned", false, "accept a bundle with no signature")
		if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 1 {
			fmt.Fprintln(stderr, usage)
			return 2
		}
		f, err := os.Open(fs.Arg(0))
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		defer f.Close()
		b, err := bundle.Verify(f, keys, *allowUnsigned)
		if err != nil {
			fmt.Fprintln(stderr, "refused:", err)
			return 1
		}
		keyID := b.KeyID
		if keyID == "" {
			keyID = "(unsigned)"
		}
		fmt.Fprintf(stdout, "ok\ndigest: %s\nkey id: %s\n", b.Digest, keyID)
		return 0
	}
	fmt.Fprintln(stderr, usage)
	return 2
}

func writeNew(path, body string, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	if _, err := f.WriteString(body); err != nil {
		f.Close()
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return f.Close()
}
