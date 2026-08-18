package api

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lets-parley/parley/internal/httprequest"
)

// Room codes avoid the character pairs people mis-read aloud (0/O, 1/I/L) —
// this code gets read off a screen and typed by someone in a hurry.
const passcodeAlphabet = "ACDEFGHJKMNPQRTUVWXY34679"

const passcodeLength = 6

func newPasscode() string {
	// Rejection sampling, not modulo: 256 is not a multiple of 25, so folding a
	// raw byte would make the first six letters ~20% more likely and quietly
	// shave entropy off the only thing guarding the room.
	const limit = 256 - (256 % len(passcodeAlphabet))
	out := make([]byte, 0, passcodeLength)
	buf := make([]byte, passcodeLength)
	for len(out) < passcodeLength {
		rand.Read(buf) // crypto/rand.Read never returns an error; it panics instead.
		for _, v := range buf {
			if int(v) < limit {
				out = append(out, passcodeAlphabet[int(v)%len(passcodeAlphabet)])
				if len(out) == passcodeLength {
					break
				}
			}
		}
	}
	return string(out)
}

// normalizePasscode lets people paste "k7m2 qx" or "k7m2-qx" and still get in.
func normalizePasscode(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		if r != ' ' && r != '-' && r != '\t' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func passcodeMatches(want, got string) bool {
	return subtle.ConstantTimeCompare([]byte(want), []byte(normalizePasscode(got))) == 1
}

// A six-character code out of a 25-character alphabet is ~244M combinations,
// which a script would walk in an afternoon unthrottled. Attempts are counted
// per client address so a wrong-code loop stalls long before it gets anywhere.
//
// The counter is in-memory, which holds while the binary asserts single-replica
// at boot; it moves to Postgres or Redis if that ever changes.
const (
	passcodeAttemptLimit  = 8
	passcodeAttemptWindow = time.Minute
)

type attemptLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
	now  func() time.Time
}

func newAttemptLimiter() *attemptLimiter {
	return &attemptLimiter{hits: map[string][]time.Time{}, now: time.Now}
}

// take reserves one guess, or reports that this client has none left.
//
// The check and the charge happen under one lock on purpose. Checking first and
// charging later reads as "only wrong answers cost a guess", but it lets every
// request that arrives at once see the same remaining budget, so a guesser gets
// a free attempt for each connection they open in parallel. The budget is spent
// up front instead, and a correct code gets it back.
func (l *attemptLimiter) take(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked()
	if len(l.hits[key]) >= passcodeAttemptLimit {
		return false
	}
	l.hits[key] = append(l.hits[key], l.now())
	return true
}

// refund hands back the guess a correct code reserved, so a whole team can file
// in through one office address without the stragglers being locked out.
func (l *attemptLimiter) refund(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n := len(l.hits[key]); n > 0 {
		if n == 1 {
			delete(l.hits, key)
		} else {
			l.hits[key] = l.hits[key][:n-1]
		}
	}
}

// blockedFor reports whether the budget is spent, without touching it.
func (l *attemptLimiter) blockedFor(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked()
	return len(l.hits[key]) >= passcodeAttemptLimit
}

func (l *attemptLimiter) sweepLocked() {
	cutoff := l.now().Add(-passcodeAttemptWindow)

	// Opportunistic sweep: without it a long-lived process accumulates a key
	// per address that ever knocked.
	for k, times := range l.hits {
		kept := times[:0]
		for _, t := range times {
			if t.After(cutoff) {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(l.hits, k)
		} else {
			l.hits[k] = kept
		}
	}
}

// clientKey identifies the caller for throttling. RemoteAddr is the peer that
// actually connected unless TRUST_PROXY_HEADERS put a forwarded address there;
// the port changes per connection and is dropped.
func clientKey(r *http.Request) string {
	if addr, ok := parseClientAddress(r.RemoteAddr); ok {
		return addr.String()
	}
	return r.RemoteAddr
}

// decodeOptional reads a small JSON body when there is one, leaving the target
// untouched when the request carries none. It never consults Content-Length,
// which a chunked request declares as -1.
func decodeOptional(w http.ResponseWriter, r *http.Request, into any) error {
	err := httprequest.DecodeJSON(w, r, 4<<10, into)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
