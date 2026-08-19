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
		conn.Close(closeCtx)
	}()

	if _, err := conn.Exec(ctx, "listen "+notifyChannel); err != nil {
		return err
	}
	a.listenerUp.Store(true)
	defer a.listenerUp.Store(false)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		from, sessionID, ok := strings.Cut(n.Payload, " ")
		if !ok {
			slog.Warn("ignoring malformed session notification", "payload", n.Payload)
			continue
		}
		// This replica already pushed the frame to its own clients when it
		// handled the mutation. Sending it again on the echo would double every
		// update for everyone connected here.
		if from == a.instanceID {
			continue
		}
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
func (a *app) listenerHealthy() bool {
	return a.listenerUp.Load()
}

