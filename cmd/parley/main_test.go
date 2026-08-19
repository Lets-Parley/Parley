package main

import "testing"

// An unstamped build has to say "dev". The API layer defaults separately, so a
// blank here still reports "dev" at /version while `parley -version` prints
// nothing — which is why this is pinned at the source rather than downstream.
func TestVersionDefaultsToDev(t *testing.T) {
	if version != "dev" {
		t.Fatalf("version = %q, want dev — an unstamped build must be honest, not blank", version)
	}
}
