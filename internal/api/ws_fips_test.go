package api

import (
	cryptofips "crypto/fips140"
	"testing"
)

// RFC 6455 §1.3 computes Sec-WebSocket-Accept with SHA-1.
// gorilla/websocket does that in computeAcceptKey, and handleWS calls
// Upgrade with no way around it. fips140=only panics on SHA-1, so every
// room dies. The -fips image therefore runs with fips140=on: approved
// algorithms still go through the module, unapproved TLS is still refused,
// and the handshake SHA-1 is allowed.
func TestFIPSModeDoesNotEnforceBecauseWebSocketSHA1(t *testing.T) {
	if cryptofips.Enforced() {
		t.Fatal("fips140=only panics on the RFC 6455 SHA-1 WebSocket accept key; the FIPS image must run with fips140=on")
	}
}
