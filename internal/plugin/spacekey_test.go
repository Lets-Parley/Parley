package plugin

import (
	"strings"
	"testing"
)

func TestSpaceKeyIsStablePerSpaceAndInstallAndRevealsNothing(t *testing.T) {
	const (
		installA = "6f1c2b9e-0d4a-4c1e-9b7a-2f3e4d5c6b7a"
		installB = "a1b2c3d4-e5f6-4789-8abc-def012345678"
		spaceX   = "11111111-2222-4333-8444-555555555555"
		spaceY   = "99999999-8888-4777-8666-555555555544"
	)
	// Two rooms in one space carry the same space id, so they must agree.
	if spaceKey(installA, spaceX) != spaceKey(installA, spaceX) {
		t.Fatal("one install and one space gave two keys")
	}
	if spaceKey(installA, spaceX) == spaceKey(installA, spaceY) {
		t.Fatal("two spaces share a key")
	}
	if spaceKey(installA, spaceX) == spaceKey(installB, spaceX) {
		t.Fatal("two installs share a key for one space")
	}
	k := spaceKey(installA, spaceX)
	if len(k) != 64 {
		t.Fatalf("key %q is not hex SHA-256", k)
	}
	for _, part := range append(strings.Split(spaceX, "-"), strings.ReplaceAll(spaceX, "-", ""), "custodial-slug", installA) {
		if strings.Contains(k, part) {
			t.Fatalf("key %q contains %q", k, part)
		}
	}
}
