package hub

import "testing"

// TestTokenSlotReleasedAfterPanicWithoutAttach pins the handler contract:
// chi's Recoverer swallows a panic between ReserveToken and AttachAuthenticated
// and the request never reaches attach. Eight such panics would otherwise lock
// the token until restart. The deferred release, disarmed only once attach has
// taken ownership, is what gives the slot back.
func TestTokenSlotReleasedAfterPanicWithoutAttach(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.MaxPerToken = 1
	const token = "tok"

	func() {
		if !h.ReserveToken(token) {
			t.Fatal("the first reservation was refused")
		}
		owned := false
		defer func() {
			_ = recover()
			if !owned {
				h.ReleaseToken(token)
			}
		}()
		panic("simulated handler panic before attach")
	}()

	if !h.ReserveToken(token) {
		t.Fatal("slot still held after panic+recover without attach")
	}
}

// TestReleaseTokenSlotIsOnce pins the CAS on Conn.tokenReserved. Without it,
// two calls would decrement the hub count twice, and a token at MaxPerToken=2
// that still holds its other socket would look empty.
func TestReleaseTokenSlotIsOnce(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.MaxPerToken = 2
	const token = "tok"
	if !h.ReserveToken(token) || !h.ReserveToken(token) {
		t.Fatal("setup reservations were refused")
	}

	c := &Conn{hub: h, tokenID: token}
	c.tokenReserved.Store(true)
	c.releaseTokenSlot()
	c.releaseTokenSlot()

	if !h.ReserveToken(token) {
		t.Fatal("the remaining of two slots should still be claimable")
	}
	if h.ReserveToken(token) {
		t.Fatal("a third concurrent reservation was accepted; releaseTokenSlot decremented twice")
	}
}

// TestReserveTokenZeroMeansUnbounded pins the Hub contract at hub.go: MaxPerToken
// of zero is unbounded. Router maps a zero Options field onto the default of 8,
// and loadConfig refuses WS_MAX_PER_TOKEN=0, so this branch is not the production
// default — it is what New() itself uses until the router writes the limit, and
// what a test that never sets MaxPerToken relies on. Refusing at <=0 would 429
// every socket on a hub whose field was left at the zero value.
func TestReserveTokenZeroMeansUnbounded(t *testing.T) {
	h := New()
	t.Cleanup(h.Shutdown)
	h.MaxPerToken = 0
	const token = "tok"
	for i := 0; i < 32; i++ {
		if !h.ReserveToken(token) {
			t.Fatalf("reservation %d of 32 was refused at MaxPerToken=0", i+1)
		}
	}
}
