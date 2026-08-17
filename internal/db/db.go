package db

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// bootLockID is an arbitrary constant; all instances must use the same value so
// the advisory lock enforces single-replica operation.
const bootLockID int64 = 0x7061726c6579

func Connect(ctx context.Context, databaseURL string, log *slog.Logger) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("invalid DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 10
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}

	backoff := time.Second
	for attempt := 1; ; attempt++ {
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = pool.Ping(pingCtx)
		cancel()
		if err == nil {
			return pool, nil
		}
		if attempt >= 6 {
			pool.Close()
			return nil, fmt.Errorf("after %d attempts: %w", attempt, err)
		}
		log.Warn("postgres not reachable yet, retrying", "attempt", attempt, "backoff", backoff.String())
		select {
		case <-ctx.Done():
			pool.Close()
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
}

// AcquireBootLock takes a session-scoped advisory lock on a dedicated connection
// held for the process lifetime. A second instance fails fast instead of running
// a split-brain in-process hub.
func AcquireBootLock(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	var got bool
	if err := conn.QueryRow(ctx, "select pg_try_advisory_lock($1)", bootLockID).Scan(&got); err != nil {
		conn.Release()
		return err
	}
	if !got {
		conn.Release()
		return fmt.Errorf("advisory lock %d already held", bootLockID)
	}
	// Intentionally never released: the lock lives as long as this connection,
	// and the connection lives as long as the process.
	return nil
}
