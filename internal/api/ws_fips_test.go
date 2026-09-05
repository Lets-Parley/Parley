package api

import (
	cryptofips "crypto/fips140"
	"os"
	"testing"
)

// TestFIPSModeDoesNotEnforceBecauseWebSocketSHA1 guards the FIPS image's
// runtime mode, not merely that Enforced() is false on a stock toolchain.
//
// RFC 6455 §1.3 computes Sec-WebSocket-Accept with SHA-1. gorilla/websocket
// does that in computeAcceptKey, and handleWS calls Upgrade with no way
// around it. fips140=only panics on SHA-1, so every room dies. The -fips
// image therefore runs with fips140=on: approved algorithms still go through
// the module, unapproved TLS is still refused, and the handshake SHA-1 is
// allowed.
//
// Enforced() alone is vacuously true whenever FIPS is off. When GOFIPS140
// is set (the go-fips CI job, the -fips image), the frozen module must
// actually be enabled or this test would stay green while the suite never
// ran under FIPS at all.
func TestFIPSModeDoesNotEnforceBecauseWebSocketSHA1(t *testing.T) {
	if cryptofips.Enforced() {
		t.Fatal("fips140=only panics on the RFC 6455 SHA-1 WebSocket accept key; the FIPS image must run with fips140=on")
	}
	if os.Getenv("GOFIPS140") != "" && !cryptofips.Enabled() {
		t.Fatal("GOFIPS140 is set but crypto/fips140.Enabled() is false")
	}
}
