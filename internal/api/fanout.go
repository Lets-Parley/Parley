package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// notifyChannel carries session ids between replicas. The payload is only an id
// and the sender's instance: every replica rebuilds the envelope from the
// database itself, so no session state ever crosses the wire and the 8KB
// payload cap is never in play.
const notifyChannel = "parley_session"

// revokeChannel carries session-token revocations between replicas. Ending a
// session deletes the token row on the replica that served the request, but the
// WebSockets it authenticated are held wherever their clients happened to land,
// and each replica's hub can only close its own. Without this, a logout leaves
// an authenticated socket live on every other replica until that connection's
// revalidate poll catches up.
//
// A channel of its own rather than a typed prefix on notifyChannel: that
// payload is parsed as "<instance> <session id>", so anything else sent down it
// is silently misread as a session id — including by an older replica still
// running mid-rolling-update, which would never learn to expect a prefix.
//
// The payload is the token *hash*, never the token itself. The hash is what the
// hub keys connections on, and it is useless as a credential. Note that a
// pg_notify payload is visible to anything able to LISTEN on this database —
// that is not a new exposure, since the same principal can already select the
// same hash out of the tokens table, but it is worth stating here rather than
// discovering later. The raw token (the cookie value) must never go on the wire.
const revokeChannel = "parley_revoke"

// listenerBackoffMax caps the reconnect delay. A replica that cannot listen is
// a replica whose clients silently stop receiving other people's votes, so it
// retries hard rather than politely.
const listenerBackoffMax = 30 * time.Second

// instanceID distinguishes this process from its replicas. It exists so the
// replica that handled a mutation can ignore the echo of its own notification
// instead of sending every client the same frame twice.
func newInstanceID() string {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		panic(err) // crypto/rand does not fail; it panics.
	}
	return hex.EncodeToString(raw)
}

// notify tells the other replicas that a session changed.
//
// Best-effort on purpose: the local broadcast has already happened by the time
// this runs, so a failure here costs remote clients one update rather than
// failing the mutation that the user just made successfully.
func (a *app) notify(ctx context.Context, sessionID string) {
	_, err := a.pool.Exec(ctx, "select pg_notify($1, $2)", notifyChannel, a.instanceID+" "+sessionID)
	if err != nil {
		slog.Error("could not notify other replicas of a session change",
			"session", sessionID, "error", err)
	}
}

// notifyRevoke tells the other replicas to drop every WebSocket authenticated
// by this token.
//
// Best-effort, exactly like notify: by the time this runs the token row is
// already deleted and the user's logout has succeeded, so a failure here must
// not turn a successful logout into a 500. The cost of a lost notification is
// bounded — a remote socket stays up until its next revalidate poll (at most
// hub's maxRevalidate, 30s), which is the documented fallback. The same applies
// to a notification sent while a replica's listener is reconnecting: Postgres
// does not queue for a session that is not listening, so it is simply missed,
// and revalidate is what closes the gap. A durable queue would buy at most
// those few seconds and cost a lot more than it is worth.
func (a *app) notifyRevoke(ctx context.Context, tokenHash []byte) {
	// Hex, not the raw bytes: a notification payload is text, and a hash is not.
	payload := a.instanceID + " " + hex.EncodeToString(tokenHash)
	if _, err := a.pool.Exec(ctx, "select pg_notify($1, $2)", revokeChannel, payload); err != nil {
		// No token material in the log line; the failure itself is the news.
		slog.Error("could not notify other replicas of a session revocation", "error", err)
	}
}

// listen keeps a dedicated connection parked on LISTEN and rebroadcasts what it
// hears to this replica's own clients.
//
// The connection is its own, not one borrowed from the pool: a LISTEN is bound
// to one backend session, so a pooled connection handed back out would take the
// subscription with it — and holding one parked would deadlock pool.Close.
func (a *app) listen(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := a.listenOnce(ctx)
		if err != nil && ctx.Err() == nil {
			a.listenerUp.Store(false)
			slog.Error("session notification listener dropped, reconnecting",
				"error", err, "backoff", backoff.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff *= 2; backoff > listenerBackoffMax {
				backoff = listenerBackoffMax
			}
			continue
		}
		backoff = time.Second
	}
}

func (a *app) listenOnce(ctx context.Context) error {
	// A connection of its own, dialled outside the pool rather than borrowed
	// from it. Borrowing deadlocks shutdown: pool.Close waits for every
	// connection to come back, and this one is parked in WaitForNotification
	// waiting for a notification that will never arrive because the process is
	// going away. It also keeps the listener from spending one of the pool's
	// (10) connections for the life of the replica.
	conn, err := pgx.ConnectConfig(ctx, a.pool.Config().ConnConfig.Copy())
	if err != nil {
		return err
	}
	defer func() {
		// Not ctx: by the time this runs ctx is usually the reason we are
		// closing, and a cancelled context closes nothing.
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := conn.Close(closeCtx); err != nil {
			// Worth seeing: a run of these during listener churn means backends
			// are being left behind on the server.
			slog.Warn("could not close the session notification connection", "error", err)
		}
	}()

	// Both channels on the one dedicated connection: a second parked connection
	// would double the idle backends for no gain.
	for _, channel := range []string{notifyChannel, revokeChannel} {
		if _, err := conn.Exec(ctx, "listen "+channel); err != nil {
			return err
		}
	}
	a.listenerUp.Store(true)
	// Cleared here as well as in listen's error branch, because a clean
	// shutdown cancels the context and returns without taking that branch —
	// leaving the replica claiming to be listening after it has stopped.
	defer a.listenerUp.Store(false)

	// Postgres does not queue notifications for a session that is not listening,
	// so everything sent while this replica was reconnecting is simply gone. Pull
	// the current state for every room still held here, or those clients sit on
	// stale state until somebody happens to touch the same session again.
	a.resyncLocalSessions(ctx)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		from, rest, ok := strings.Cut(n.Payload, " ")
		if !ok {
			slog.Warn("ignoring malformed notification", "channel", n.Channel)
			continue
		}
		// This replica already did the work locally when it handled the
		// request. Acting on the echo would double every update for everyone
		// connected here, and re-run a disconnect that is already done.
		if from == a.instanceID {
			continue
		}
		switch n.Channel {
		case notifyChannel:
			a.broadcastLocal(ctx, rest)
		case revokeChannel:
			tokenHash, err := hex.DecodeString(rest)
			if err != nil {
				slog.Warn("ignoring malformed revocation notification", "error", err)
				continue
			}
			a.hub.DisconnectToken(string(tokenHash))
		}
	}
}

// resyncLocalSessions rebuilds and pushes state for every room this replica
// holds, without notifying anyone else — the other replicas did not miss
// anything, this one did.
func (a *app) resyncLocalSessions(ctx context.Context) {
	for _, sessionID := range a.hub.Sessions() {
		a.broadcastLocal(ctx, sessionID)
	}
}

// listenerHealthy reports whether this replica is currently subscribed.
//
// /readyz consults it, which matters more than it looks: the pool can be
// perfectly healthy while the listener is dead, and in that state the replica
// serves requests and holds WebSockets but never learns about anything
// happening on another pod. Without this the failure is invisible — the pod
// stays Ready, `helm test` passes, and rooms silently split.
//
// Reported the moment it drops, with no grace period of its own: the probe
// already supplies one (a readiness failureThreshold of 3 at 5s apart is ~15s),
// and a transient drop is back inside a second or two on the first backoff. A
// second timer here would only make a real outage take longer to show up.
//
// Note this also gates the container HEALTHCHECK, which calls /readyz. A
// replica that cannot listen for longer than the probe tolerates leaves the
// Service — correct when there are peers to be out of step with, and a
// deliberate trade at one replica, where the pool being fine while the listener
// is not means something is genuinely wrong with the database connection.
func (a *app) listenerHealthy() bool {
	return a.listenerUp.Load()
}
