package plugin

import (
	"errors"
	"testing"
)

func TestPublicationCipherRequiresBinding(t *testing.T) {
	c := mustCipher(t, oldSecretKey, "")
	aad := []byte("publication-connection|one|org|space|room|principal")
	n, b, key, err := c.Seal(aad, "secret")
	if err != nil {
		t.Fatal(err)
	}
	rotated := mustCipher(t, newSecretKey, oldSecretKey)
	if got, err := rotated.OpenBound(key, aad, n, b); err != nil || got != "secret" {
		t.Fatalf("previous key bound read: %q %v", got, err)
	}
	if _, err := rotated.OpenBound(key, []byte("foreign"), n, b); !errors.Is(err, ErrSecretUndecryptable) {
		t.Fatal("foreign binding opened")
	}
	n, b, key, err = c.sealUnbound("legacy")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.OpenBound(key, aad, n, b); !errors.Is(err, ErrSecretUndecryptable) {
		t.Fatal("publication accepted legacy unbound secret")
	}
}
