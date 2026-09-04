package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Job is one unit of deferred work.
//
// run_at is still how the queue decides what is due. A five-field cron on
// parley_job_enqueue is converted into the next run_at at schedule time; the
// claim path is unchanged.
type Job struct {
	ID        int64
	InstallID string
	Kind      string
	Payload   json.RawMessage
	Attempts  int
	RunAt     time.Time
}

// Queue is the job queue and its worker. Claims use FOR UPDATE SKIP LOCKED for
// the same reason the outbox does: a second worker is configuration.
type Queue struct {
	Pool *pgxpool.Pool
	// Run performs one job. Like an event handler it may see the same job more
	// than once — a worker can die after the work and before the bookkeeping —
	// so it must be idempotent.
	Run func(context.Context, Job) error

	MaxAttempts int
	BaseBackoff time.Duration
	Batch       int
	Lease       time.Duration
	Log         *slog.Logger

	noRunWarnOnce sync.Once
}

// Enqueue adds a job and returns its id.
func (q *Queue) Enqueue(ctx context.Context, job Job) (int64, error) {
	payload := job.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	runAt := job.RunAt
	if runAt.IsZero() {
		runAt = time.Now()
	}
	var installID *string
	if job.InstallID != "" {
		installID = &job.InstallID
	}
	var id int64
	if err := q.Pool.QueryRow(ctx, `
		insert into plugin_jobs (install_id, kind, payload, run_at)
		values ($1, $2, $3, $4)
		returning id`, installID, job.Kind, []byte(payload), runAt).Scan(&id); err != nil {
		return 0, fmt.Errorf("enqueueing %s job: %w", job.Kind, err)
	}
	return id, nil
}

// Claim takes up to n due jobs, charges each an attempt, and leases them away
// from other claimers for the same reason the outbox does.
func (q *Queue) Claim(ctx context.Context, n int) ([]Job, error) {
	rows, err := q.Pool.Query(ctx, `
		with claimed as (
			select id from plugin_jobs
			where state = 'pending' and run_at <= now()
			order by run_at, id
			limit $1
			for update skip locked
		)
		update plugin_jobs j
		set attempts = j.attempts + 1, run_at = now() + $2::interval, updated_at = now()
		from claimed c
		where j.id = c.id
		returning j.id, coalesce(j.install_id::text, ''), j.kind, j.payload, j.attempts`,
		n, orDefaultDuration(q.Lease, DefaultLease).String())
	if err != nil {
		return nil, fmt.Errorf("claiming jobs: %w", err)
	}
	defer rows.Close()

	var out []Job
	for rows.Next() {
		var job Job
		var payload []byte
		if err := rows.Scan(&job.ID, &job.InstallID, &job.Kind, &payload, &job.Attempts); err != nil {
			return nil, fmt.Errorf("reading claimed job: %w", err)
		}
		job.Payload = payload
		out = append(out, job)
	}
	return out, rows.Err()
}

// Drain claims a batch, runs each job, and records the outcome.
func (q *Queue) Drain(ctx context.Context) (int, error) {
	if q.Run == nil {
		q.noRunWarnOnce.Do(func() {
			if q.Log != nil {
				q.Log.Warn("plugin job queue has no Run handler configured; jobs will accumulate unrun")
			}
		})
		return 0, nil
	}
	claimed, err := q.Claim(ctx, orDefaultInt(q.Batch, DefaultBatch))
	if err != nil {
		return 0, err
	}
	for _, job := range claimed {
		runErr := q.Run(ctx, job)
		if runErr == nil {
			tag, err := q.Pool.Exec(ctx,
				`update plugin_jobs set state = 'done', last_error = null, updated_at = now() where id = $1`,
				job.ID)
			if err != nil {
				return len(claimed), fmt.Errorf("marking job %d done: %w", job.ID, err)
			}
			// An uninstall cascades plugin_jobs away underneath a worker that
			// is already running one. Legitimate, but not silent.
			q.warnVanished(tag.RowsAffected(), job)
			continue
		}
		state, backoff := settle(job.Attempts, orDefaultInt(q.MaxAttempts, DefaultMaxAttempts), q.BaseBackoff)
		tag, err := q.Pool.Exec(ctx, `
			update plugin_jobs
			set state = $2, last_error = $3, run_at = now() + $4::interval, updated_at = now()
			where id = $1`, job.ID, state, truncateError(runErr), backoff.String())
		if err != nil {
			return len(claimed), fmt.Errorf("recording job %d failure: %w", job.ID, err)
		}
		q.warnVanished(tag.RowsAffected(), job)
		if state == "dead" && q.Log != nil {
			q.Log.Warn("plugin job dead-lettered after repeated failures",
				"job_id", job.ID, "kind", job.Kind, "attempts", job.Attempts, "error", runErr)
		}
	}
	return len(claimed), nil
}

// RunWorker drains on a ticker until ctx is done.
func (q *Queue) RunWorker(ctx context.Context, interval time.Duration) {
	runLoop(ctx, interval, q.Log, "plugin job queue", func(ctx context.Context) error {
		_, err := q.Drain(ctx)
		return err
	})
}

// warnVanished says so when the job row a worker was running is no longer
// there — cascaded away by an uninstall while it ran.
func (q *Queue) warnVanished(affected int64, job Job) {
	if affected != 0 || q.Log == nil {
		return
	}
	q.Log.Warn("plugin job vanished mid-run; its outcome was dropped",
		"job_id", job.ID, "install_id", job.InstallID, "kind", job.Kind)
}
