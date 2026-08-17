package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
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

// allow records an attempt and reports whether it may proceed.
func (l *attemptLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
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

	if len(l.hits[key]) >= passcodeAttemptLimit {
		return false
	}
	l.hits[key] = append(l.hits[key], l.now())
	return true
}

// clientKey identifies the caller for throttling. RealIP has already applied
// the proxy headers, so RemoteAddr is the best address available; the port
// changes per connection and is dropped.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// decodeOptional reads a small JSON body when there is one, leaving the target
// untouched when the request carries none. It never consults Content-Length,
// which a chunked request declares as -1.
func decodeOptional(w http.ResponseWriter, r *http.Request, into any) error {
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(into)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
