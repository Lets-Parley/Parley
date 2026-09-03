package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/dbtest"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(context.Background(), pool, slog.New(slog.NewTextHandler(os.Stderr, nil)), db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	return pool
}

var installNo int

// topic returns a topic unique to this run. Installs accumulate in the shared
// test database, so a fixed topic would leave every previous run's install
// still subscribed to it.
func topic(t *testing.T) string {
	t.Helper()
	installNo++
	return fmt.Sprintf("test.%d.%d", time.Now().UnixNano(), installNo)
}

// testOrgID is the default org, the fixed id 0021_orgs.sql gave it. Installs
// belong to an org since 0034, and the tests in this package are about the
// host rather than about ownership, so they all file under the same one; the
// cross-org attack is pinned in internal/api, where the org comes from the
// request.
const testOrgID = "00000000-0000-0000-0000-000000000001"

// install creates an install with a name unique to this run.
func install(t *testing.T, s *Store, grants ...Grant) Install {
	t.Helper()
	installNo++
	name := fmt.Sprintf("%s-%d-%d", strings.ToLower(t.Name()), time.Now().UnixNano(), installNo)
	got, err := s.Install(context.Background(), InstallRequest{
		OrgID:      testOrgID,
		Name:       name,
		Version:    "1.0.0",
		Grants:     grants,
		QuotaBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestCoreSubscribersRunInProcessAndPluginsGoThroughTheOutbox(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	revealed := topic(t)
	sub := install(t, store, Grant{Capability: CapabilityEvents, Scope: revealed})

	bus := &Bus{Pool: pool}
	var seen []Event
	bus.SubscribeCore(revealed, func(_ context.Context, ev Event) { seen = append(seen, ev) })

	var ran bool
	err := bus.WithEvents(ctx, []Event{{Topic: revealed, Payload: json.RawMessage(`{"round":1}`)}},
		func(pgx.Tx) error { ran = true; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !ran {
		t.Fatal("the transactional body never ran")
	}

	// Core: in-process and synchronous, so it has already happened.
	if len(seen) != 1 || seen[0].Topic != revealed {
		t.Fatalf("core subscriber saw %v, want one %s event", seen, revealed)
	}

	// Plugin: a pending outbox row, not a direct call.
	var state string
	if err := pool.QueryRow(ctx, `
		select d.state from plugin_deliveries d
		join plugin_events e on e.id = d.event_id
		where d.install_id = $1 and e.topic = $2`, sub.ID, revealed).Scan(&state); err != nil {
		t.Fatalf("no delivery queued for the subscribed plugin: %v", err)
	}
	if state != "pending" {
		t.Fatalf("delivery state is %q, want pending", state)
	}
}

func TestRollbackLeavesNoEventAndNoCoreFanout(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	deleted := topic(t)
	bus := &Bus{Pool: pool}
	var seen int
	bus.SubscribeCore(deleted, func(context.Context, Event) { seen++ })

	boom := errors.New("boom")
	err := bus.WithEvents(ctx, []Event{{Topic: deleted, Payload: json.RawMessage(`{}`)}},
		func(pgx.Tx) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("WithEvents returned %v, want the body's error", err)
	}
	if seen != 0 {
		t.Fatalf("core subscriber ran %d times for a rolled-back change", seen)
	}
	var n int
	if err := pool.QueryRow(ctx, `select count(*) from plugin_events where topic = $1`, deleted).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d events survived a rollback", n)
	}
}

func TestUnsubscribedAndDisabledInstallsGetNoDelivery(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	added := topic(t)
	other := install(t, store, Grant{Capability: CapabilityEvents, Scope: topic(t)})
	off := install(t, store, Grant{Capability: CapabilityEvents, Scope: added})
	if _, err := pool.Exec(ctx, `update plugin_installs set enabled = false where id = $1`, off.ID); err != nil {
		t.Fatal(err)
	}

	bus := &Bus{Pool: pool}
	if err := bus.Publish(ctx, Event{Topic: added, Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{other.ID, off.ID} {
		var n int
		if err := pool.QueryRow(ctx, `select count(*) from plugin_deliveries where install_id = $1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("install %s got %d deliveries it never subscribed to (or was disabled for)", id, n)
		}
	}
}

// Two claimers, one queue. SKIP LOCKED is easy to write and easy to write
// wrong, and the way it goes wrong is a subscriber handed the same event twice
// from the claim path.
func TestConcurrentClaimersNeverHandTheSameDeliveryTwice(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	race := topic(t)
	sub := install(t, store, Grant{Capability: CapabilityEvents, Scope: race})

	bus := &Bus{Pool: pool}
	const events = 40
	for i := 0; i < events; i++ {
		if err := bus.Publish(ctx, Event{Topic: race, Payload: json.RawMessage(`{}`)}); err != nil {
			t.Fatal(err)
		}
	}

	var mu sync.Mutex
	delivered := map[int64]int{}
	worker := func() *Outbox {
		return &Outbox{Pool: pool, Deliver: func(_ context.Context, d Delivery) error {
			mu.Lock()
			delivered[d.ID]++
			mu.Unlock()
			return nil
		}}
	}

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o := worker()
			for {
				n, err := o.Drain(ctx)
				if err != nil {
					t.Error(err)
					return
				}
				if n == 0 {
					return
				}
			}
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	var mine int
	for id, count := range delivered {
		if count != 1 {
			t.Errorf("delivery %d was handed out %d times", id, count)
		}
		var owner string
		if err := pool.QueryRow(ctx, `select install_id from plugin_deliveries where id = $1`, id).Scan(&owner); err != nil {
			t.Fatal(err)
		}
		if owner == sub.ID {
			mine++
		}
	}
	if mine != events {
		t.Fatalf("delivered %d of this test's %d events", mine, events)
	}
}

func TestFailingDeliveryBacksOffThenDeadLetters(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	fails := topic(t)
	sub := install(t, store, Grant{Capability: CapabilityEvents, Scope: fails})

	bus := &Bus{Pool: pool}
	if err := bus.Publish(ctx, Event{Topic: fails, Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}

	o := &Outbox{
		Pool:        pool,
		MaxAttempts: 3,
		BaseBackoff: time.Hour,
		Deliver:     func(context.Context, Delivery) error { return errors.New("subscriber is down") },
	}

	if _, err := o.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	state, attempts, available := deliveryRow(t, pool, sub.ID)
	if state != "pending" || attempts != 1 {
		t.Fatalf("after one failure: state %q attempts %d, want pending/1", state, attempts)
	}
	if !available.After(time.Now().Add(30 * time.Minute)) {
		t.Fatalf("a failed delivery is available again at %s — it is not backing off", available)
	}

	// A backed-off delivery is not claimable, so it cannot starve live work.
	if n, err := o.Drain(ctx); err != nil || n != 0 {
		t.Fatalf("Drain claimed %d backed-off deliveries (err %v), want 0", n, err)
	}

	for i := 0; i < 2; i++ {
		if _, err := pool.Exec(ctx, `update plugin_deliveries set available_at = now() where install_id = $1`, sub.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := o.Drain(ctx); err != nil {
			t.Fatal(err)
		}
	}
	state, attempts, _ = deliveryRow(t, pool, sub.ID)
	if state != "dead" || attempts != 3 {
		t.Fatalf("after %d attempts: state %q, want dead at 3", attempts, state)
	}

	var lastErr *string
	if err := pool.QueryRow(ctx, `select last_error from plugin_deliveries where install_id = $1`, sub.ID).Scan(&lastErr); err != nil {
		t.Fatal(err)
	}
	if lastErr == nil || !strings.Contains(*lastErr, "subscriber is down") {
		t.Fatalf("dead-lettered delivery kept last_error %v, want the failure recorded", lastErr)
	}
}

func deliveryRow(t *testing.T, pool *pgxpool.Pool, installID string) (string, int, time.Time) {
	t.Helper()
	var state string
	var attempts int
	var available time.Time
	if err := pool.QueryRow(context.Background(),
		`select state, attempts, available_at from plugin_deliveries where install_id = $1`, installID).
		Scan(&state, &attempts, &available); err != nil {
		t.Fatal(err)
	}
	return state, attempts, available
}

func TestRetentionPrunesDeliveredEventsPastTheWindow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	old := topic(t)
	sub := install(t, store, Grant{Capability: CapabilityEvents, Scope: old})

	bus := &Bus{Pool: pool}
	if err := bus.Publish(ctx, Event{Topic: old, Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update plugin_events set created_at = now() - interval '30 days' where topic = $1`, old); err != nil {
		t.Fatal(err)
	}

	// Still in flight: pruning it would drop a delivery that has not happened.
	if _, err := store.Prune(ctx, 7*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if got := countDeliveries(t, pool, sub.ID); got != 1 {
		t.Fatalf("an undelivered event was pruned (%d deliveries left)", got)
	}

	if _, err := pool.Exec(ctx, `update plugin_deliveries set state = 'delivered' where install_id = $1`, sub.ID); err != nil {
		t.Fatal(err)
	}
	n, err := store.Prune(ctx, 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("Prune removed nothing")
	}
	if got := countDeliveries(t, pool, sub.ID); got != 0 {
		t.Fatalf("%d deliveries survived the retention window", got)
	}
}

func countDeliveries(t *testing.T, pool *pgxpool.Pool, installID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `select count(*) from plugin_deliveries where install_id = $1`, installID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestKeyValueQuotaCounterTracksTheWriteAndRefusesTheOverflow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	sub := install(t, store)

	if err := store.Put(ctx, sub.ID, "a", make([]byte, 600)); err != nil {
		t.Fatal(err)
	}
	if got := usedBytes(t, pool, sub.ID); got != 600 {
		t.Fatalf("counter is %d after a 600-byte write, want 600", got)
	}

	// Overwriting charges the delta, not the whole value again.
	if err := store.Put(ctx, sub.ID, "a", make([]byte, 700)); err != nil {
		t.Fatal(err)
	}
	if got := usedBytes(t, pool, sub.ID); got != 700 {
		t.Fatalf("counter is %d after overwriting 600 bytes with 700, want 700", got)
	}

	if err := store.Put(ctx, sub.ID, "b", make([]byte, 400)); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("writing past the 1024-byte quota returned %v, want ErrQuotaExceeded", err)
	}
	if got := usedBytes(t, pool, sub.ID); got != 700 {
		t.Fatalf("a refused write moved the counter to %d, want 700", got)
	}
	if _, ok, err := store.Get(ctx, sub.ID, "b"); err != nil || ok {
		t.Fatalf("the refused write is readable back (ok=%v, err=%v)", ok, err)
	}

	if err := store.Delete(ctx, sub.ID, "a"); err != nil {
		t.Fatal(err)
	}
	if got := usedBytes(t, pool, sub.ID); got != 0 {
		t.Fatalf("counter is %d after deleting the only key, want 0", got)
	}
}

func TestReconcileCorrectsADriftedQuotaCounter(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	sub := install(t, store)
	if err := store.Put(ctx, sub.ID, "a", make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update plugin_installs set kv_bytes = 0 where id = $1`, sub.ID); err != nil {
		t.Fatal(err)
	}

	drifted, err := store.ReconcileQuotas(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if drifted == 0 {
		t.Fatal("ReconcileQuotas reported no drift on a counter that was wrong")
	}
	if got := usedBytes(t, pool, sub.ID); got != 100 {
		t.Fatalf("counter is %d after reconciliation, want 100", got)
	}
}

func usedBytes(t *testing.T, pool *pgxpool.Pool, installID string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(context.Background(), `select kv_bytes from plugin_installs where id = $1`, installID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSecretsAreEncryptedAtRestAndRefuseToInstallWithoutAKey(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	keyless := &Store{Pool: pool}
	_, err := keyless.Install(ctx, InstallRequest{
		OrgID:      testOrgID,
		Name:       fmt.Sprintf("keyless-%d", time.Now().UnixNano()),
		Version:    "1.0.0",
		Grants:     []Grant{{Capability: CapabilitySecrets}},
		QuotaBytes: 1024,
	})
	if !errors.Is(err, ErrNoSecretKey) {
		t.Fatalf("installing a secrets-using plugin with no key returned %v, want ErrNoSecretKey", err)
	}

	cipher, err := NewCipher(strings.Repeat("A", 44)[:43] + "=")
	if err != nil {
		t.Fatal(err)
	}
	keyed := &Store{Pool: pool, Cipher: cipher}
	sub := install(t, keyed, Grant{Capability: CapabilitySecrets})

	const plaintext = "hunter2-webhook-token"
	if err := keyed.PutSecret(ctx, sub.ID, "webhook", plaintext); err != nil {
		t.Fatal(err)
	}
	var stored []byte
	if err := pool.QueryRow(ctx, `select ciphertext from plugin_secrets where install_id = $1`, sub.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), plaintext) {
		t.Fatal("the secret is stored in the clear")
	}
	got, err := keyed.GetSecret(ctx, sub.ID, "webhook")
	if err != nil || got != plaintext {
		t.Fatalf("GetSecret returned (%q, %v), want the plaintext back", got, err)
	}
}

func TestPutSecretRefusesToWritePlaintextWithoutAKey(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	sub := install(t, store)

	if err := store.PutSecret(ctx, sub.ID, "webhook", "hunter2"); !errors.Is(err, ErrNoSecretKey) {
		t.Fatalf("PutSecret with no cipher configured returned %v, want ErrNoSecretKey", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `select count(*) from plugin_secrets where install_id = $1`, sub.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("a refused PutSecret still wrote %d row(s) to plugin_secrets", n)
	}

	if _, err := store.GetSecret(ctx, sub.ID, "webhook"); !errors.Is(err, ErrNoSecretKey) {
		t.Fatalf("GetSecret with no cipher configured returned %v, want ErrNoSecretKey", err)
	}
}

func TestJobsAreClaimedOnceAndDeadLetterAfterTheirAttempts(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &Store{Pool: pool}
	sub := install(t, store)

	q := &Queue{Pool: pool}
	kind := topic(t)
	id, err := q.Enqueue(ctx, Job{InstallID: sub.ID, Kind: kind, Payload: json.RawMessage(`{"n":1}`)})
	if err != nil {
		t.Fatal(err)
	}

	var runs int
	var got Job
	q.Run = func(_ context.Context, j Job) error {
		if j.ID == id {
			runs++
			got = j
		}
		return nil
	}
	if _, err := q.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	var payload struct{ N int }
	if err := json.Unmarshal(got.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || got.Kind != kind || payload.N != 1 {
		t.Fatalf("handler ran %d times and got %+v, want the enqueued job exactly once", runs, got)
	}
	if _, err := q.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	if runs != 1 {
		t.Fatalf("a finished job was claimed again (%d runs)", runs)
	}

	doomed := topic(t)
	failing := &Queue{Pool: pool, MaxAttempts: 2, BaseBackoff: time.Millisecond,
		Run: func(context.Context, Job) error { return errors.New("nope") }}
	if _, err := failing.Enqueue(ctx, Job{InstallID: sub.ID, Kind: doomed}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := pool.Exec(ctx, `update plugin_jobs set run_at = now() where kind = $1`, doomed); err != nil {
			t.Fatal(err)
		}
		if _, err := failing.Drain(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var state string
	var attempts int
	if err := pool.QueryRow(ctx, `select state, attempts from plugin_jobs where kind = $1`, doomed).Scan(&state, &attempts); err != nil {
		t.Fatal(err)
	}
	if state != "dead" || attempts != 2 {
		t.Fatalf("doomed job is %q after %d attempts, want dead at 2", state, attempts)
	}
}
