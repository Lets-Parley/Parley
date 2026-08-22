package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/httprequest"
)

// Passcodes avoid the character pairs people mis-read aloud (0/O, 1/I/L) —
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
// The counter lives in Postgres, so every replica spends from the same budget:
// a per-process counter would quietly hand out the limit N times over with N
// replicas behind a load balancer.
const (
	passcodeAttemptLimit  = 8
	passcodeAttemptWindow = time.Minute
)

type attemptLimiter struct {
	pool *pgxpool.Pool
	// now is the process clock, and deliberately nothing below reads it. Every
	// timestamp these statements compare is taken from Postgres, so replicas
	// whose clocks have drifted apart still agree on when a window ends: one
	// running fast cannot write a window_start in the future for the others to
	// honour, and cannot sweep away rows whose window has not elapsed. The seam
	// stays so a test can hand a limiter a deliberately wrong clock and prove
	// the shared budget does not move with it.
	now func() time.Time
}

func newAttemptLimiter(pool *pgxpool.Pool) *attemptLimiter {
	return &attemptLimiter{pool: pool, now: time.Now}
}

// attemptDigest keeps the client address out of the table: the row is only ever
// compared for equality, so a one-way digest of it does the whole job.
func attemptDigest(key string) []byte {
	sum := sha256.Sum256([]byte(key))
	return sum[:]
}

// take reserves one guess, or reports that this client has none left.
//
// The check and the charge happen in one statement on purpose. Checking first
// and charging later reads as "only wrong answers cost a guess", but it lets
// every request that arrives at once see the same remaining budget, so a
// guesser gets a free attempt for each connection they open in parallel. A
// transaction boundary is not enough either: under READ COMMITTED two replicas
// both read the same under-limit count and both proceed. The upsert below is
// the whole check: a conflicting writer blocks on the row lock, then re-reads
// the committed row before its own WHERE is evaluated, so the count it sees
// already includes the other replica's charge. The budget is spent up front,
// and a correct code gets it back.
func (l *attemptLimiter) take(ctx context.Context, key string) bool {
	window := passcodeAttemptWindow.Seconds()

	var attempts int
	err := l.pool.QueryRow(ctx, `
		insert into passcode_attempts (client_digest, attempts, window_start)
		values ($1, 1, now())
		on conflict (client_digest) do update
		set attempts = case when passcode_attempts.window_start <= now() - make_interval(secs => $3) then 1
		                    else passcode_attempts.attempts + 1 end,
		    window_start = case when passcode_attempts.window_start <= now() - make_interval(secs => $3) then now()
		                        else passcode_attempts.window_start end
		where passcode_attempts.attempts < $2 or passcode_attempts.window_start <= now() - make_interval(secs => $3)
		returning attempts`,
		attemptDigest(key), passcodeAttemptLimit, window).Scan(&attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		// A database that cannot count the guess cannot bound it either, so the
		// door stays shut rather than opening unmetered.
		return false
	}

	// Opportunistic sweep: without it the table keeps a row per address that
	// ever knocked, including the addresses that never come back, so it has to
	// stay unkeyed to be a garbage collector at all. That is only safe because
	// the cutoff is server time: every replica computes the same one, and it
	// can only remove a row the statement above would have reset anyway. It
	// runs after the charge so a slow delete never delays the decision the
	// caller is waiting on.
	l.pool.Exec(ctx, "delete from passcode_attempts where window_start <= now() - make_interval(secs => $1)", window)
	return true
}

// refund hands back the guess a correct code reserved, so a whole team can file
// in through one office address without the stragglers being locked out.
func (l *attemptLimiter) refund(ctx context.Context, key string) {
	l.pool.Exec(ctx, `
		update passcode_attempts set attempts = attempts - 1
		where client_digest = $1 and attempts > 0
		  and window_start > now() - make_interval(secs => $2)`,
		attemptDigest(key), passcodeAttemptWindow.Seconds())
}

// blockedFor reports whether the budget is spent, without touching it.
func (l *attemptLimiter) blockedFor(ctx context.Context, key string) bool {
	var attempts int
	err := l.pool.QueryRow(ctx, `
		select attempts from passcode_attempts
		where client_digest = $1 and window_start > now() - make_interval(secs => $2)`,
		attemptDigest(key), passcodeAttemptWindow.Seconds()).Scan(&attempts)
	// No row is the honest answer that this client has nothing counted against
	// it. Any other failure means the budget could not be read, and reporting
	// an unreadable budget as available would announce a spent one as free.
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		return true
	}
	return attempts >= passcodeAttemptLimit
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
