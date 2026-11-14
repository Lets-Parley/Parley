package plugin

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/store"
)

// createRaceAdvisoryClass and createRaceAdvisoryObj name the barrier lock.
// The process's own advisory locks are a single bigint (the migration lock
// 0x7061726c65796d, and the retired boot lock 0x7061726c6579). A two-int key
// is a different slot — objsubid 2, not 1 — so this cannot collide with either.
const (
	createRaceAdvisoryClass int32 = 515
	createRaceAdvisoryObj   int32 = 1
)

// TestCreateWaitsOutAnInFlightKindRetirement is one half of the race between
// uninstall's retirement update and Sessions.Create. The retirement is in
// flight and uncommitted; Create has to block on that row, then refuse, and
// leave no session behind. A non-locking read of session_kinds does not wait,
// so both transactions can commit.
func TestCreateWaitsOutAnInFlightKindRetirement(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	room := newRaceRoom(t, pool)
	plugins := &Store{Pool: pool}

	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	letUninstallFinish := func() { releaseOnce.Do(func() { close(release) }) }
	// Release before the cleanups that wait for Create. Create is blocked on
	// this transaction, and those cleanups run before this one.
	defer letUninstallFinish()
	uninstalled := make(chan error, 1)
	uninstallDone := make(chan struct{})
	go func() {
		defer close(uninstallDone)
		uninstalled <- plugins.InOrg(testOrgID).Uninstall(ctx, room.install.ID, func(context.Context, pgx.Tx) error {
			close(entered)
			<-release
			return nil
		})
	}()
	t.Cleanup(func() {
		letUninstallFinish()
		select {
		case <-uninstallDone:
		case <-time.After(5 * time.Second):
			t.Errorf("uninstall was still running after the barrier was released")
		}
	})

	select {
	case <-entered:
	case err := <-uninstalled:
		t.Fatalf("uninstall finished before its retirement was held open: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("uninstall never reached the in-transaction hook, so the retirement was not held open")
	}

	created := make(chan error, 1)
	createDone := make(chan struct{})
	go func() {
		defer close(createDone)
		_, err := (&store.Sessions{Pool: pool}).Create(ctx, room.spaceID, room.kind, "Race", []byte(`{}`), room.userID, 500)
		created <- err
	}()
	t.Cleanup(func() {
		select {
		case <-createDone:
		case <-time.After(5 * time.Second):
			t.Errorf("Create was still running after the barrier was released")
		}
	})

	// Postgres records a row-lock wait as an ungranted ShareLock on the other
	// transaction, not as a tuple ForShare row. ShareLock plus this statement
	// is the FOR SHARE wait: FOR UPDATE would be an ExclusiveLock, and the
	// foreign key's ForKeyShare never reaches this statement.
	waitForLock(t, pool, created, "Create to block on the kind row", `
		select exists (
			select 1
			from pg_locks l
			join pg_stat_activity a on a.pid = l.pid
			where not l.granted
			  and l.locktype = 'transactionid'
			  and l.mode = 'ShareLock'
			  and a.query like '%for share%'
		)`)

	letUninstallFinish()

	select {
	case err := <-created:
		if !errors.Is(err, store.ErrKindRetired) {
			t.Fatalf("Create = %v, want ErrKindRetired once the retirement commits", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Create did not return after the uninstall committed")
	}
	select {
	case err := <-uninstalled:
		if err != nil {
			t.Fatalf("uninstall = %v, want it to commit once Create was only waiting", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("uninstall did not finish after the hook was released")
	}
	if n := sessionsOfKind(t, pool, room.kind); n != 0 {
		t.Fatalf("sessions of the retired kind = %d, want none", n)
	}
}

// TestUninstallWaitsOutAnInFlightSessionCreate is the other half. Create has
// share-locked the kind and is inside its insert, and has not committed.
// Uninstall's retirement update has to block on that share lock. The insert
// then commits, uninstall fails because the session exists, and the install
// row is still there.
//
// The barrier is a BEFORE INSERT trigger that waits on an advisory lock held
// by a dedicated connection. Create takes its share lock before the insert,
// so while the trigger waits the share lock is already held. Releasing the
// advisory lock lets the insert commit; the uninstall, queued on the share
// lock, then sees the session.
func TestUninstallWaitsOutAnInFlightSessionCreate(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	room := newRaceRoom(t, pool)
	plugins := &Store{Pool: pool}

	unlock := holdAdvisoryLock(t)
	defer unlock()
	installCreateRaceTrigger(t, pool, room.kind)

	created := make(chan error, 1)
	createDone := make(chan struct{})
	go func() {
		defer close(createDone)
		_, err := (&store.Sessions{Pool: pool}).Create(ctx, room.spaceID, room.kind, "Race", []byte(`{}`), room.userID, 500)
		created <- err
	}()
	t.Cleanup(func() {
		unlock()
		select {
		case <-createDone:
		case <-time.After(5 * time.Second):
			t.Errorf("Create was still running after the advisory lock was released")
		}
	})

	waitForLock(t, pool, created, "Create to block in the insert trigger", `
		select exists (
			select 1 from pg_locks
			where locktype = 'advisory'
			  and classid = $1
			  and objid = $2
			  and objsubid = 2
			  and not granted
		)`, createRaceAdvisoryClass, createRaceAdvisoryObj)

	uninstalled := make(chan error, 1)
	uninstallDone := make(chan struct{})
	go func() {
		defer close(uninstallDone)
		uninstalled <- plugins.InOrg(testOrgID).Uninstall(ctx, room.install.ID, nil)
	}()
	t.Cleanup(func() {
		select {
		case <-uninstallDone:
		case <-time.After(5 * time.Second):
			t.Errorf("uninstall was still running after the advisory lock was released")
		}
	})

	// The retirement update waits on Create's share lock. Postgres reports that
	// wait against the holder's transaction id; the statement text is what
	// identifies it as the kind update. A trigger wait alone does not block it.
	waitForLock(t, pool, uninstalled, "uninstall to block on the kind row", `
		select exists (
			select 1
			from pg_locks l
			join pg_stat_activity a on a.pid = l.pid
			where not l.granted
			  and l.locktype = 'transactionid'
			  and a.query like '%update session_kinds set retired_at%'
		)`)

	unlock()

	select {
	case err := <-created:
		if err != nil {
			t.Fatalf("Create = %v, want the in-flight session to commit", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Create did not finish after the advisory lock was released")
	}
	select {
	case err := <-uninstalled:
		var blocked *BlockedError
		if !errors.As(err, &blocked) {
			t.Fatalf("uninstall = %v, want a BlockedError once the session exists", err)
		}
		if len(blocked.Sessions) != 1 || blocked.Sessions[0].Kind != room.kind || blocked.Sessions[0].Sessions != 1 {
			t.Fatalf("the refusal says %+v, and the one in-flight session is what blocks it", blocked.Sessions)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("uninstall did not finish after Create committed")
	}
	if _, err := plugins.State(ctx, room.install.ID); err != nil {
		t.Fatalf("the install row is gone after the refused uninstall: %v", err)
	}
	if n := sessionsOfKind(t, pool, room.kind); n != 1 {
		t.Fatalf("sessions of the kind = %d, want the one Create committed", n)
	}
	var retired *time.Time
	if err := pool.QueryRow(ctx, `select retired_at from session_kinds where kind = $1`, room.kind).Scan(&retired); err != nil {
		t.Fatal(err)
	}
	if retired != nil {
		t.Fatal("a refused uninstall retired the kind anyway")
	}
}

// holdAdvisoryLock takes the barrier lock on a connection that is not from the
// pool, so Create and uninstall can still check out pool connections while it
// is held. The unlock is idempotent: the test releases it to open the barrier,
// and cleanup releases it again if the test never got that far.
func holdAdvisoryLock(t *testing.T) func() {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `select pg_advisory_lock($1, $2)`, createRaceAdvisoryClass, createRaceAdvisoryObj); err != nil {
		conn.Close(ctx)
		t.Fatal(err)
	}
	var once sync.Once
	unlock := func() {
		once.Do(func() {
			_, _ = conn.Exec(context.Background(), `select pg_advisory_unlock($1, $2)`, createRaceAdvisoryClass, createRaceAdvisoryObj)
			_ = conn.Close(context.Background())
		})
	}
	t.Cleanup(unlock)
	return unlock
}

// installCreateRaceTrigger pauses the insert Create is about to do. The WHEN
// clause limits it to this test's kind, so a trigger that survived a crash
// cannot stall every other insert. Cleanup removes it even when the test fails.
func installCreateRaceTrigger(t *testing.T, pool *pgxpool.Pool, kind string) {
	t.Helper()
	ctx := context.Background()
	fn := fmt.Sprintf(`
		create or replace function parley_test_create_race_wait() returns trigger
		language plpgsql as $fn$
		begin
			perform pg_advisory_lock(%d, %d);
			perform pg_advisory_unlock(%d, %d);
			return new;
		end;
		$fn$`, createRaceAdvisoryClass, createRaceAdvisoryObj, createRaceAdvisoryClass, createRaceAdvisoryObj)
	if _, err := pool.Exec(ctx, fn); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		if _, err := pool.Exec(c, `drop trigger if exists parley_test_create_race_wait on sessions`); err != nil {
			t.Errorf("dropping the create-race trigger: %v", err)
		}
		if _, err := pool.Exec(c, `drop function if exists parley_test_create_race_wait()`); err != nil {
			t.Errorf("dropping the create-race trigger function: %v", err)
		}
	})
	create := fmt.Sprintf(`
		create trigger parley_test_create_race_wait
		before insert on sessions
		for each row
		when (new.kind = %s)
		execute function parley_test_create_race_wait()`, sqlQuote(kind))
	if _, err := pool.Exec(ctx, create); err != nil {
		t.Fatal(err)
	}
}

func sqlQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// waitForLock polls pg_locks until query reports the wait the barrier has to
// produce. The poll observes the barrier; it is not the barrier. Early
// completion of the operation under test is a failure, not a pass.
func waitForLock(t *testing.T, pool *pgxpool.Pool, early <-chan error, what, query string, args ...any) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-early:
			t.Fatalf("%s: the operation finished before it was blocked: %v", what, err)
		default:
		}
		var waiting bool
		if err := pool.QueryRow(context.Background(), query, args...).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s\n%s", what, lockDump(pool))
}

func lockDump(pool *pgxpool.Pool) string {
	var dump string
	err := pool.QueryRow(context.Background(), `
		select coalesce(string_agg(line, E'\n'), '')
		from (
			select format('%s %s granted=%s rel=%s :: %s',
				l.locktype, l.mode, l.granted, coalesce(c.relname, ''),
				left(regexp_replace(coalesce(a.query, ''), '\s+', ' ', 'g'), 140)) as line
			from pg_locks l
			left join pg_class c on c.oid = l.relation
			left join pg_stat_activity a on a.pid = l.pid
			where not l.granted
		) s`).Scan(&dump)
	if err != nil {
		return fmt.Sprintf("could not read pg_locks: %v", err)
	}
	if dump == "" {
		return "no ungranted locks"
	}
	return dump
}

type raceRoom struct {
	install Install
	kind    string
	spaceID string
	userID  string
}

func newRaceRoom(t *testing.T, pool *pgxpool.Pool) raceRoom {
	t.Helper()
	ctx := context.Background()
	in := shortInstall(t, &Store{Pool: pool}, "race")
	kind := "r" + strings.ReplaceAll(in.ID, "-", "")
	if _, err := pool.Exec(ctx,
		`insert into session_kinds (kind, provider, display, org_id) values ($1, $2, 'Retrospective', $3)`,
		kind, in.Name, testOrgID); err != nil {
		t.Fatal(err)
	}
	var userID, spaceID string
	if err := pool.QueryRow(ctx, `insert into users (name) values ('Race User') returning id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into spaces (org_id, slug, name, passcode) values ($1, $2, 'Race', 'seedpass') returning id`,
		testOrgID, "s"+strings.ReplaceAll(in.ID, "-", "")).Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `delete from sessions where kind = $1`, kind)
		_, _ = pool.Exec(c, `delete from session_kinds where kind = $1`, kind)
		_, _ = pool.Exec(c, `delete from spaces where id = $1`, spaceID)
		_, _ = pool.Exec(c, `delete from users where id = $1`, userID)
		_, _ = pool.Exec(c, `delete from plugin_installs where id = $1`, in.ID)
	})
	return raceRoom{install: in, kind: kind, spaceID: spaceID, userID: userID}
}

func sessionsOfKind(t *testing.T, pool *pgxpool.Pool, kind string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `select count(*) from sessions where kind = $1`, kind).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
