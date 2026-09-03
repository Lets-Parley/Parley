package plugin

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedSession puts one room of a given kind in the database. Sessions hang off
// a space, an org and a user, so the whole chain is created here rather than
// pulled in from internal/store — this package deliberately imports none of it.
func seedSession(t *testing.T, pool *pgxpool.Pool, kind string) string {
	t.Helper()
	ctx := context.Background()
	var orgID, userID, spaceID, sessionID string
	suffix := kind
	if err := pool.QueryRow(ctx,
		`insert into orgs (slug, name, claim_value) values ($1, $1, $1) returning id`, "org-"+suffix).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into users (name) values ($1) returning id`, "Seed "+suffix).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into spaces (org_id, slug, name, passcode) values ($1, $2, $2, 'seedpass')
		 returning id`, orgID, "space-"+suffix).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into sessions (space_id, kind, title, facilitator_id)
		 values ($1, $2, 'Seeded room', $3) returning id`, spaceID, kind, userID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from orgs where id = $1`, orgID)
		_, _ = pool.Exec(context.Background(), `delete from users where id = $1`, userID)
	})
	return sessionID
}

// shortInstall names an install briefly: session_kinds.provider is capped at
// 64 characters, and the shared `install` helper derives its name from the
// test's own, which is longer than that here.
func shortInstall(t *testing.T, store *Store, prefix string) Install {
	t.Helper()
	installNo++
	got, err := store.Install(context.Background(), InstallRequest{
		OrgID:      testOrgID,
		Name:       fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixNano(), installNo),
		Version:    "1.0.0",
		Grants:     []Grant{{Capability: CapabilityLog}},
		QuotaBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// Uninstall destroys encrypted secrets and everything else cascading from the
// install, so the tests below are about it refusing when it should and being
// impossible to reach by accident when a disable was meant.

func TestUninstallRemovesTheInstall(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	in := install(t, store, Grant{Capability: CapabilityLog})

	if err := store.InOrg(testOrgID).Uninstall(ctx, in.ID, nil); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if _, err := store.State(ctx, in.ID); err == nil {
		t.Fatal("the install is still readable after being uninstalled")
	}
}

// The refusal has to name what blocks it. "Cannot uninstall" with no reason
// leaves an operator with nothing to act on.
func TestUninstallIsRefusedWhileASessionOfAProvidedKindExists(t *testing.T) {
	pool := testPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()
	in := shortInstall(t, store, "retro")

	kind := "retro-" + in.ID[:8]
	if _, err := pool.Exec(ctx,
		`insert into session_kinds (kind, provider, display) values ($1, $2, 'Retrospective')`,
		kind, in.Name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from sessions where kind = $1`, kind)
		_, _ = pool.Exec(context.Background(), `delete from session_kinds where kind = $1`, kind)
	})

	// Nothing of that kind exists yet, so the uninstall is not blocked.
	blocking, err := store.BlockingSessions(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocking) != 0 {
		t.Fatalf("a plugin with no sessions of its kind is blocked by %v", blocking)
	}

	seedSession(t, pool, kind)

	err = store.InOrg(testOrgID).Uninstall(ctx, in.ID, nil)
	var blocked *BlockedError
	if !errors.As(err, &blocked) {
		t.Fatalf("uninstall = %v, want a BlockedError while a session of a provided kind exists", err)
	}
	if len(blocked.Sessions) != 1 || blocked.Sessions[0].Kind != kind || blocked.Sessions[0].Sessions != 1 {
		t.Fatalf("the refusal says %+v, and one Retrospective session is what blocks it", blocked.Sessions)
	}
	if !strings.Contains(blocked.Error(), "Retrospective") {
		t.Fatalf("the refusal does not name the kind that blocks it: %q", blocked.Error())
	}
	if _, err := store.State(ctx, in.ID); err != nil {
		t.Fatalf("a refused uninstall removed the install anyway: %v", err)
	}
}

// An ended room is still history, and history that cannot resolve its own kind
// is broken history — so ending the session is not a way past the refusal.
func TestAnEndedSessionStillBlocksAnUninstall(t *testing.T) {
	pool := testPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()
	in := shortInstall(t, store, "ended")

	kind := "ended-" + in.ID[:8]
	if _, err := pool.Exec(ctx,
		`insert into session_kinds (kind, provider, display) values ($1, $2, 'Retrospective')`,
		kind, in.Name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from sessions where kind = $1`, kind)
		_, _ = pool.Exec(context.Background(), `delete from session_kinds where kind = $1`, kind)
	})
	id := seedSession(t, pool, kind)
	if _, err := pool.Exec(ctx, `update sessions set ended_at = now() where id = $1`, id); err != nil {
		t.Fatal(err)
	}

	var blocked *BlockedError
	if err := store.InOrg(testOrgID).Uninstall(ctx, in.ID, nil); !errors.As(err, &blocked) {
		t.Fatalf("uninstall = %v, want a BlockedError: an ended room still names the kind", err)
	}
}

// The circuit breaker's judgement lives in memory. Before this it lived only
// in memory *and* in the log, so a degraded plugin was indistinguishable on
// any screen from a plugin with nothing to do.
func TestHealthSurfacesTheBreakerState(t *testing.T) {
	h := NewHost(&Store{}, HostConfig{BreakerFailures: 1, BreakerCooldown: time.Minute})

	if got := h.Health("nobody", true); got.State != HealthOK {
		t.Fatalf("a plugin the host has never called reads as %q, want %q", got.State, HealthOK)
	}

	h.mu.Lock()
	b := h.breakerFor("plug")
	b.lastErr = "dial tcp: connection refused"
	b.openTill = time.Now().Add(time.Minute)
	b.reason = "it failed repeatedly"
	h.mu.Unlock()

	got := h.Health("plug", true)
	if got.State != HealthDegraded {
		t.Fatalf("state = %q, want %q", got.State, HealthDegraded)
	}
	if got.LastError != "dial tcp: connection refused" {
		t.Fatalf("last error = %q, and the operator needs the real one", got.LastError)
	}
	if got.Reason == "" || got.RecoversAt == nil {
		t.Fatalf("a degraded plugin reported no reason or no recovery time: %+v", got)
	}

	// Disabled is durable and comes from the store, so it wins over the
	// in-memory cooldown — and it carries the breaker's reason when the
	// breaker is what disabled it.
	off := h.Health("plug", false)
	if off.State != HealthDisabled || off.Reason != "it failed repeatedly" {
		t.Fatalf("a disabled plugin reported %+v, want the breaker's own reason", off)
	}
	// With no breaker entry at all, a disabled plugin is an operator's doing.
	if got := h.Health("nobody", false); got.Reason != "an operator switched it off" {
		t.Fatalf("reason = %q, want the operator wording", got.Reason)
	}
}

// Uninstalling retires the kinds the plugin provided.
//
// health.go always said kinds are "retired rather than deleted", but nothing
// performed the retirement: after uninstalling a plugin with no live sessions,
// a *new* room of its kind could still be created naming a provider that no
// longer existed. The retirement happens in the uninstall's own transaction,
// which is also what closes the window between the blocking check and the
// delete.
func TestUninstallRetiresTheKindsThePluginProvided(t *testing.T) {
	pool := testPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()
	in := shortInstall(t, store, "retire")

	kind := "retire-" + in.ID[:8]
	if _, err := pool.Exec(ctx,
		`insert into session_kinds (kind, provider, display) values ($1, $2, 'Retrospective')`,
		kind, in.Name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from sessions where kind = $1`, kind)
		_, _ = pool.Exec(context.Background(), `delete from session_kinds where kind = $1`, kind)
	})

	if err := store.InOrg(testOrgID).Uninstall(ctx, in.ID, nil); err != nil {
		t.Fatalf("uninstalling a plugin with no rooms of its kind: %v", err)
	}

	var retired *time.Time
	if err := pool.QueryRow(ctx,
		`select retired_at from session_kinds where kind = $1`, kind).Scan(&retired); err != nil {
		t.Fatalf("the kind row is gone; it is retired, never deleted: %v", err)
	}
	if retired == nil {
		t.Fatal("the kind is still offerable after its provider was uninstalled: a new room could name a provider that does not exist")
	}
}

// A refused uninstall changes nothing at all — including the retirement it
// performs before it looks. The check and the delete are one transaction, so
// a refusal rolls the whole thing back.
func TestARefusedUninstallLeavesTheKindOfferable(t *testing.T) {
	pool := testPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()
	in := shortInstall(t, store, "rollback")

	kind := "rollback-" + in.ID[:8]
	if _, err := pool.Exec(ctx,
		`insert into session_kinds (kind, provider, display) values ($1, $2, 'Retrospective')`,
		kind, in.Name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from sessions where kind = $1`, kind)
		_, _ = pool.Exec(context.Background(), `delete from session_kinds where kind = $1`, kind)
	})
	seedSession(t, pool, kind)

	var blocked *BlockedError
	if err := store.InOrg(testOrgID).Uninstall(ctx, in.ID, nil); !errors.As(err, &blocked) {
		t.Fatalf("uninstall = %v, want a BlockedError", err)
	}
	var retired *time.Time
	if err := pool.QueryRow(ctx,
		`select retired_at from session_kinds where kind = $1`, kind).Scan(&retired); err != nil {
		t.Fatal(err)
	}
	if retired != nil {
		t.Fatal("a refused uninstall retired the kind anyway: the rollback did not cover it")
	}
}

// The caller's work rides in the uninstall's transaction, so an uninstall
// cannot complete with its audit row missing. A hook that fails takes the
// delete down with it.
func TestAFailingHookRollsTheUninstallBack(t *testing.T) {
	pool := testPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()
	in := shortInstall(t, store, "hook")

	boom := errors.New("the audit row could not be written")
	err := store.InOrg(testOrgID).Uninstall(ctx, in.ID, func(context.Context, pgx.Tx) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("uninstall = %v, want the hook's own error", err)
	}
	if _, err := store.State(ctx, in.ID); err != nil {
		t.Fatalf("the install was destroyed even though the work that had to accompany it failed: %v", err)
	}
}

// An install belonging to another org is not reachable at all, and answers the
// same way an id that was never issued answers.
func TestAnInstallOfAnotherOrgIsNotFound(t *testing.T) {
	pool := testPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()
	in := shortInstall(t, store, "owned")

	var otherOrg string
	if err := pool.QueryRow(ctx,
		`insert into orgs (slug, name, claim_value) values ($1, $1, $1) returning id`,
		fmt.Sprintf("org-%d", installNo)+in.ID[:8]).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `delete from orgs where id = $1`, otherOrg) })

	other := store.InOrg(otherOrg)
	if _, err := other.State(ctx, in.ID); !errors.Is(err, ErrNoSuchInstall) {
		t.Fatalf("reading another org's install = %v, want ErrNoSuchInstall", err)
	}
	if err := other.SetEnabled(ctx, in.ID, false); !errors.Is(err, ErrNoSuchInstall) {
		t.Fatalf("disabling another org's install = %v, want ErrNoSuchInstall", err)
	}
	if err := other.Uninstall(ctx, in.ID, nil); !errors.Is(err, ErrNoSuchInstall) {
		t.Fatalf("uninstalling another org's install = %v, want ErrNoSuchInstall", err)
	}
	if _, err := store.State(ctx, in.ID); err != nil {
		t.Fatalf("the install did not survive another org's attempt on it: %v", err)
	}
	// An id nobody ever issued is refused the same way, so the surface cannot
	// be used to tell the two apart.
	if _, err := other.State(ctx, "3f1d2c4b-5a6e-4b7c-8d9e-0a1b2c3d4e5f"); !errors.Is(err, ErrNoSuchInstall) {
		t.Fatalf("an id that does not exist = %v, want the same ErrNoSuchInstall a foreign one gets", err)
	}
}
