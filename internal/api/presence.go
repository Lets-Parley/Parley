package api

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/recovery"
)

// presenceSweepInterval is how often stale rows are cleared. Half the freshness
// window, so a row is never visible for much longer than the window itself even
// though the query already filters on age.
const presenceSweepInterval = hub.PongDeadline

// replicaID names this pod in presence rows.
//
// It reads POD_NAME, which the chart supplies from the downward API, because a
// stable per-pod name makes a stuck row traceable to the pod that wrote it.
// Falling back to the instance id keeps things correct off Kubernetes, where
// the rows are still distinct per process — just less legible.
func replicaID() string {
	if name := os.Getenv("POD_NAME"); name != "" {
		return name
	}
	return newInstanceID()
}

// sweepPresence clears rows left behind by replicas that stopped without
// closing their sockets. A pod that is OOMKilled or SIGKILLed never runs the
// disconnect path, so without this its people stay in the room forever.
func (a *app) sweepPresence(ctx context.Context) {
	a.sweepLoop(ctx, presenceSweepInterval, func(ctx context.Context) error {
		return a.presence.Sweep(ctx)
	})
}

// sweepLoop is sweepPresence with its pass injected, so a test can make the
// pass panic without a database.
func (a *app) sweepLoop(ctx context.Context, every time.Duration, sweep func(context.Context) error) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepOnce(ctx, sweep)
		}
	}
}

// sweepOnce contains a panicking pass. Without this the sweeper is a bare
// goroutine, so one bad row would end the process rather than one pass.
func sweepOnce(ctx context.Context, sweep func(context.Context) error) {
	defer recovery.Handle("presence sweeper")
	if err := sweep(ctx); err != nil && ctx.Err() == nil {
		slog.Error("could not sweep stale presence rows", "error", err)
	}
}
