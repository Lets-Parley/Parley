package standup

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/lets-parley/parley/internal/plugin"
)

// The expected hex was computed outside Go, with
// `printf '%s' "$body" | openssl dgst -sha256 -hmac fixture-secret`, so this
// fails if the signature or the payload's byte layout drifts.
func TestWebhookSignatureVerifiesAgainstAFixture(t *testing.T) {
	body, err := json.Marshal(webhookPayload{
		Event:      "standup.closed",
		ID:         "0b1c2d3e-0000-4000-8000-000000000001",
		SessionURL: "https://parley.example/session/s1",
		Space:      webhookSpace{Org: "default", Slug: "team"},
	})
	if err != nil {
		t.Fatal(err)
	}
	const wantBody = `{"event":"standup.closed","id":"0b1c2d3e-0000-4000-8000-000000000001","sessionUrl":"https://parley.example/session/s1","space":{"org":"default","slug":"team"}}`
	if string(body) != wantBody {
		t.Fatalf("payload:\n got %s\nwant %s", body, wantBody)
	}
	const want = "sha256=6d507f9a17b9f234fd190378ac905110ad57fef5b5767a333d6ec045ad4a5207"
	if got := SignWebhook("fixture-secret", body); got != want {
		t.Fatalf("signature: got %s, want %s", got, want)
	}
}

type sent struct {
	url     string
	headers map[string]string
	body    string
}

func webhookFixture(t *testing.T, send func(context.Context, string, map[string]string, []byte) (int, error)) (*Webhooks, string) {
	t.Helper()
	pool := testPool(t)
	sess, _ := seed(t, pool, `{"mode":"async"}`, "Ada")
	w := &Webhooks{
		Pool:    pool,
		BaseURL: "https://parley.example",
		Seal:    func(s string) ([]byte, []byte, error) { return []byte("n"), []byte(s), nil },
		Open:    func(_, c []byte) (string, error) { return string(c), nil },
		Send:    send,
	}
	// The webhook predates the session so the sweep sees its opening.
	if err := w.Put(context.Background(), sess.SpaceID, "", "https://hooks.example/in", "s3cret"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), "update standup_webhooks set created_at = now() - interval '1 minute'"); err != nil {
		t.Fatal(err)
	}
	return w, sess.ID
}

// A failed delivery is retried with the same event id and byte-identical
// body, so a receiver can drop the duplicate; and a second sweep never mints
// a second event for the same session and event type.
func TestADuplicateDeliveryCarriesTheSameEventID(t *testing.T) {
	var got []sent
	fail := true
	w, sessID := webhookFixture(t, func(_ context.Context, u string, h map[string]string, b []byte) (int, error) {
		got = append(got, sent{u, h, string(b)})
		if fail {
			return 500, nil
		}
		return 200, nil
	})
	ctx := context.Background()
	for range 2 {
		if err := w.Enqueue(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Deliver(ctx); err != nil {
		t.Fatal(err)
	}
	fail = false
	if _, err := w.Pool.Exec(ctx, "update standup_webhook_deliveries set next_attempt_at = now()"); err != nil {
		t.Fatal(err)
	}
	if err := w.Enqueue(ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.Deliver(ctx); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("deliveries: got %d, want 2 (one failure, one retry)", len(got))
	}
	a, b := got[0], got[1]
	if a.headers["X-Parley-Event-Id"] == "" || a.headers["X-Parley-Event-Id"] != b.headers["X-Parley-Event-Id"] || a.body != b.body {
		t.Fatalf("retry differs:\n%+v\n%+v", a, b)
	}
	if a.headers["X-Parley-Signature"] != SignWebhook("s3cret", []byte(a.body)) {
		t.Fatalf("signature header %q does not verify", a.headers["X-Parley-Signature"])
	}
	var p webhookPayload
	if err := json.Unmarshal([]byte(a.body), &p); err != nil {
		t.Fatal(err)
	}
	if p.Event != "standup.opened" || p.SessionURL != "https://parley.example/session/"+sessID || p.ID != a.headers["X-Parley-Event-Id"] {
		t.Fatalf("payload: %+v", p)
	}
	// Delivered: nothing more goes out.
	if err := w.Deliver(ctx); err != nil || len(got) != 2 {
		t.Fatalf("delivered event was sent again: %d %v", len(got), err)
	}
}

// A claim leases every row in the batch, then delivers them one at a time,
// each allowed to wait as long as the plugin fetch timeout. The product of
// those two has to finish with a timeout to spare, or a hanging receiver
// lets the lease lapse while rows from this batch are still in flight and
// another replica claims them again.
func TestWebhookClaimBatchFitsInsideTheLease(t *testing.T) {
	if webhookClaimLimit < 1 || webhookLease <= 0 {
		t.Fatalf("claim limit %d lease %s", webhookClaimLimit, webhookLease)
	}
	budget := time.Duration(webhookClaimLimit) * plugin.DefaultFetchTimeout
	if budget >= webhookLease || webhookLease-budget <= plugin.DefaultFetchTimeout {
		t.Fatalf("claiming %d deliveries at %s each takes %s, which is not comfortably inside the %s lease",
			webhookClaimLimit, plugin.DefaultFetchTimeout, budget, webhookLease)
	}
}

// Delivered and failed rows leave the outbox 30 days after they reached that
// state. A row still waiting, and one delivered more recently, stay.
func TestOldWebhookDeliveriesAreForgotten(t *testing.T) {
	w, sessID := webhookFixture(t, func(context.Context, string, map[string]string, []byte) (int, error) {
		return 204, nil
	})
	ctx := context.Background()
	var spaceID, facilitator string
	if err := w.Pool.QueryRow(ctx, "select space_id::text, facilitator_id::text from sessions where id = $1", sessID).Scan(&spaceID, &facilitator); err != nil {
		t.Fatal(err)
	}
	insertSession := func() string {
		t.Helper()
		var id string
		if err := w.Pool.QueryRow(ctx, `
			insert into sessions (space_id, kind, title, config, facilitator_id)
			values ($1, 'standup', 'Older', '{}', $2) returning id::text`, spaceID, facilitator).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	done := insertSession()
	waiting := insertSession()
	insert := func(session, event, column, age, marker string) {
		t.Helper()
		q := `insert into standup_webhook_deliveries (space_id, session_id, event, attempts, last_error, ` + column + `)
			values ($1, $2, $3, 1, $4, now() - interval '` + age + `')`
		if _, err := w.Pool.Exec(ctx, q, spaceID, session, event, marker); err != nil {
			t.Fatal(err)
		}
	}
	insert(done, "standup.opened", "delivered_at", "31 days", "old-delivered")
	insert(done, "standup.closed", "failed_at", "31 days", "old-failed")
	insert(done, "standup.ended", "delivered_at", "29 days", "recent-delivered")
	if _, err := w.Pool.Exec(ctx, `
		insert into standup_webhook_deliveries (space_id, session_id, event, next_attempt_at, last_error, created_at)
		values ($1, $2, 'standup.opened', now() + interval '1 day', 'still-waiting', now() - interval '40 days')`,
		spaceID, waiting); err != nil {
		t.Fatal(err)
	}
	if webhookRetention != 30*24*time.Hour {
		t.Fatalf("retention is %s, want 30 days", webhookRetention)
	}
	w.pass(ctx)
	var oldN, recentN, waitingN int
	if err := w.Pool.QueryRow(ctx, `
		select
			count(*) filter (where last_error in ('old-delivered', 'old-failed')),
			count(*) filter (where last_error = 'recent-delivered'),
			count(*) filter (where last_error = 'still-waiting' and delivered_at is null and failed_at is null)
		from standup_webhook_deliveries`).Scan(&oldN, &recentN, &waitingN); err != nil {
		t.Fatal(err)
	}
	if oldN != 0 || recentN != 1 || waitingN != 1 {
		t.Fatalf("after the sweep: old terminal rows %d (want 0), recent delivered %d (want 1), still waiting %d (want 1)", oldN, recentN, waitingN)
	}
}

// Five attempts, then the event is given up on.
func TestWebhookDeliveryGivesUpAfterFiveAttempts(t *testing.T) {
	calls := 0
	w, _ := webhookFixture(t, func(context.Context, string, map[string]string, []byte) (int, error) {
		calls++
		return 0, errors.New("connection refused")
	})
	ctx := context.Background()
	if err := w.Enqueue(ctx); err != nil {
		t.Fatal(err)
	}
	for range 7 {
		if err := w.Deliver(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Pool.Exec(ctx, "update standup_webhook_deliveries set next_attempt_at = now()"); err != nil {
			t.Fatal(err)
		}
	}
	if calls != WebhookMaxAttempts {
		t.Fatalf("attempts: got %d, want %d", calls, WebhookMaxAttempts)
	}
}

// standup.closed fires once the cutoff has passed, and standup.ended once the
// session ends. No entry text is ever in a payload: it carries four fields.
func TestClosedAndEndedEventsFire(t *testing.T) {
	var events []string
	w, sessID := webhookFixture(t, func(_ context.Context, _ string, _ map[string]string, b []byte) (int, error) {
		var p map[string]any
		_ = json.Unmarshal(b, &p)
		if len(p) != 4 {
			t.Errorf("payload has %d keys: %s", len(p), b)
		}
		events = append(events, p["event"].(string))
		return 204, nil
	})
	ctx := context.Background()
	past := time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	if _, err := w.Pool.Exec(ctx, "update sessions set config = jsonb_build_object('mode','async','closesAt',$2::text) where id = $1", sessID, past); err != nil {
		t.Fatal(err)
	}
	if err := w.Enqueue(ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.Deliver(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Pool.Exec(ctx, "update sessions set ended_at = now() where id = $1", sessID); err != nil {
		t.Fatal(err)
	}
	if err := w.Enqueue(ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.Deliver(ctx); err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for _, e := range events {
		seen[e]++
	}
	if len(events) != 3 || seen["standup.opened"] != 1 || seen["standup.closed"] != 1 || seen["standup.ended"] != 1 {
		t.Fatalf("events: %v", events)
	}
}
