package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestACronExpressionIsTurnedIntoRunAtOnTheExistingQueue(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityJobs})
	st, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	q := &Queue{Pool: store.Pool}
	h := &Host{Store: store, Queue: q}

	kind := topic(t)
	raw, err := json.Marshal(map[string]any{"kind": kind, "cron": "0 9 * * *"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := h.enqueue(ctx, st, &callInfo{installID: in.ID, mode: ModeAsync}, raw)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := out.(map[string]any)
	id, _ := got["job_id"].(int64)
	if id == 0 {
		t.Fatalf("enqueue returned %v; want a job_id", out)
	}

	var runAt time.Time
	if err := store.Pool.QueryRow(ctx, `select run_at from plugin_jobs where id = $1`, id).Scan(&runAt); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if !runAt.After(now) {
		t.Fatalf("run_at %s is not in the future; cron must be converted to the next occurrence, not run immediately", runAt)
	}
	if runAt.UTC().Hour() != 9 || runAt.UTC().Minute() != 0 {
		t.Fatalf("run_at %s is not 09:00 UTC, so the cron was not turned into run_at", runAt.UTC())
	}

	claimed, err := q.Claim(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range claimed {
		if job.ID == id {
			t.Fatal("the existing claim picked a cron job whose run_at is still in the future")
		}
	}
}

func TestAnInvalidCronIsRefusedAndStoresNothing(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityJobs})
	st, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	h := &Host{Store: store, Queue: &Queue{Pool: store.Pool}}

	raw, err := json.Marshal(map[string]any{"kind": "work", "cron": "not a schedule"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := h.enqueue(ctx, st, &callInfo{installID: in.ID, mode: ModeAsync}, raw)
	if err == nil {
		t.Fatalf("enqueue stored %v for garbage cron; want a refusal", out)
	}
	if !errors.Is(err, ErrInvalidCron) {
		t.Fatalf("got %v, want ErrInvalidCron so a guest sees a schedule error rather than a silent no-op", err)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "cron") {
		t.Fatalf("the refusal reads %q; it should name the cron", err)
	}

	var n int
	if err := store.Pool.QueryRow(ctx, `select count(*) from plugin_jobs where install_id = $1`, in.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("a refused cron still wrote %d plugin_jobs row(s)", n)
	}
}

func TestCronAndDelayTogetherAreRefused(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityJobs})
	st, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	h := &Host{Store: store, Queue: &Queue{Pool: store.Pool}}

	raw, err := json.Marshal(map[string]any{"kind": "work", "cron": "* * * * *", "delay_ms": 1000})
	if err != nil {
		t.Fatal(err)
	}
	out, err := h.enqueue(ctx, st, &callInfo{installID: in.ID, mode: ModeAsync}, raw)
	if err == nil {
		t.Fatalf("enqueue stored %v for cron and delay_ms together; they are two clocks", out)
	}
	if !errors.Is(err, ErrInvalidCron) {
		t.Fatalf("got %v, want ErrInvalidCron so a guest sees a schedule error rather than a silent no-op", err)
	}

	var n int
	if err := store.Pool.QueryRow(ctx, `select count(*) from plugin_jobs where install_id = $1`, in.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("a refused cron-and-delay still wrote %d plugin_jobs row(s)", n)
	}
}

func TestACronEnqueueStillRequiresTheJobsGrant(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store)
	st, err := store.State(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	h := &Host{Store: store, Queue: &Queue{Pool: store.Pool}}

	raw, err := json.Marshal(map[string]any{"kind": "work", "cron": "0 9 * * *"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := h.enqueue(ctx, st, &callInfo{installID: in.ID, mode: ModeAsync}, raw)
	if err == nil {
		t.Fatalf("enqueue stored %v with no jobs grant; want a refusal", out)
	}
	if !errors.Is(err, ErrNotGranted) {
		t.Fatalf("got %v, want ErrNotGranted so a cron schedule is not a way around the jobs grant", err)
	}

	var n int
	if err := store.Pool.QueryRow(ctx, `select count(*) from plugin_jobs where install_id = $1`, in.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("an ungranted cron enqueue still wrote %d plugin_jobs row(s)", n)
	}
}
