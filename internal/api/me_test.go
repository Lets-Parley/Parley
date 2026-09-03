package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"

	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/store"
)

// testPool hands back an empty, migrated database. Every caller starts from an
// empty schema, so tests never inherit each other's rows.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	resetSchema(t)
	return pool
}

// resetSchema returns the database to the state a test expects: the schema the
// migrations build, holding exactly the rows they seed and nothing else.
//
// It used to drop the public schema and re-run every migration per test. That
// is the clearest way to express "fresh", but it is also the single largest
// fixed cost in this package: the migrations are deterministic, so all but the
// first of those runs rebuild a schema identical to the one just discarded,
// and this package asks for a database several hundred times. Migrating once
// per test binary and emptying it between tests is the same guarantee — no
// test can observe another's rows or identity values — for a fraction of the
// wall clock.
//
// Emptying means truncate, then restore the rows the migrations themselves
// inserted. Those are captured from the migrated database rather than listed
// here, so a migration that seeds a new row is carried automatically instead
// of quietly going missing from every test after this one.
//
// The reset runs on its own pool rather than the caller's, so a caller that is
// watching its pool (counting round trips, forcing a plan) sees only its own
// traffic.
func resetSchema(t *testing.T) {
	t.Helper()
	schemaOnce.Do(func() { schema, schemaErr = migrateOnce(dbtest.DSN(t)) })
	if schemaErr != nil {
		t.Fatal(schemaErr)
	}
	if err := schema.reset(context.Background()); err != nil {
		t.Fatal(err)
	}
}

var (
	schemaOnce sync.Once
	schema     *testSchema
	schemaErr  error
)

// testSchema is the migrated schema shared by every test in this binary, and
// what it takes to put it back the way the migrations left it.
type testSchema struct {
	pool *pgxpool.Pool
	// truncate empties every table but the migrations ledger, which is
	// bookkeeping rather than test data: truncating it would tell a later
	// Migrate call that nothing had ever been applied.
	truncate string
	// seeds holds the rows the migrations inserted, in an order that satisfies
	// the foreign keys between them.
	seeds []tableSeed
}

type tableSeed struct {
	table string
	rows  []byte
}

// reset empties the shared schema. A test is allowed to change the schema
// itself — one drops org_members to stand in for a pre-migration database — so
// a truncate that no longer matches the tables in front of it is not a failure
// but a signal to rebuild. That path costs the full migration, and is paid only
// by the test that follows such a test rather than by all of them.
func (s *testSchema) reset(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, s.truncate); err != nil {
		if err := s.rebuild(ctx); err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, s.truncate); err != nil {
			return err
		}
	}
	for _, seed := range s.seeds {
		conn, err := s.pool.Acquire(ctx)
		if err != nil {
			return err
		}
		_, err = conn.Conn().PgConn().CopyFrom(ctx,
			bytes.NewReader(seed.rows), "copy "+seed.table+" from stdin")
		conn.Release()
		if err != nil {
			return fmt.Errorf("restoring seed rows for %s: %w", seed.table, err)
		}
	}
	return nil
}

// migrateOnce builds the schema every test in this binary shares. The pool it
// returns outlives every test, so it is deliberately never closed: the process
// exiting is its cleanup.
func migrateOnce(dsn string) (*testSchema, error) {
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		return nil, err
	}
	s := &testSchema{pool: pool}
	if err := s.rebuild(context.Background()); err != nil {
		return nil, err
	}
	return s, nil
}

// rebuild migrates a fresh schema and re-learns how to empty it: which tables
// exist, in what order they can be restored, and what the migrations seeded.
func (s *testSchema) rebuild(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := db.Migrate(ctx, s.pool, log, db.MigrationsFS); err != nil {
		return err
	}
	tables, err := migratedTables(ctx, s.pool)
	if err != nil {
		return err
	}
	if len(tables) == 0 {
		return fmt.Errorf("the migrated schema has no tables")
	}
	seeds, err := captureSeeds(ctx, s.pool, tables)
	if err != nil {
		return err
	}
	// restart identity so a test cannot pass by matching an id that another
	// test happened to leave the sequence sitting on.
	s.truncate = "truncate table " + strings.Join(tables, ", ") + " restart identity cascade"
	s.seeds = seeds
	return nil
}

// migratedTables lists the tables to empty, ordered so that a table comes
// after every table it references. Restoring seed rows in that order cannot
// trip a foreign key.
func migratedTables(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `
		select quote_ident(c.relname),
		       coalesce(array_agg(distinct quote_ident(r.relname))
		                filter (where r.relname is not null and r.relname <> c.relname), '{}')
		from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		left join pg_constraint fk on fk.conrelid = c.oid and fk.contype = 'f'
		left join pg_class r on r.oid = fk.confrelid
		where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'migrations'
		group by c.relname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	deps := map[string][]string{}
	for rows.Next() {
		var table string
		var refs []string
		if err := rows.Scan(&table, &refs); err != nil {
			return nil, err
		}
		deps[table] = refs
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return topoSort(deps), nil
}

// topoSort orders tables so a table follows everything it references. A cycle
// between tables cannot be ordered; its members are appended in name order so
// the result still names every table, and a seed row inside such a cycle would
// fail loudly at restore rather than be dropped silently here.
func topoSort(deps map[string][]string) []string {
	names := make([]string, 0, len(deps))
	for name := range deps {
		names = append(names, name)
	}
	slices.Sort(names)
	var order []string
	placed := map[string]bool{}
	for len(order) < len(names) {
		progressed := false
		for _, name := range names {
			if placed[name] {
				continue
			}
			ready := true
			for _, ref := range deps[name] {
				if _, known := deps[ref]; known && !placed[ref] {
					ready = false
					break
				}
			}
			if ready {
				order = append(order, name)
				placed[name] = true
				progressed = true
			}
		}
		if !progressed {
			for _, name := range names {
				if !placed[name] {
					order = append(order, name)
					placed[name] = true
				}
			}
		}
	}
	return order
}

// captureSeeds copies out whatever the migrations left behind, so the reset can
// put it back.
func captureSeeds(ctx context.Context, pool *pgxpool.Pool, tables []string) ([]tableSeed, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	var seeds []tableSeed
	for _, table := range tables {
		var buf bytes.Buffer
		if _, err := conn.Conn().PgConn().CopyTo(ctx, &buf, "copy "+table+" to stdout"); err != nil {
			return nil, fmt.Errorf("capturing seed rows for %s: %w", table, err)
		}
		if buf.Len() > 0 {
			seeds = append(seeds, tableSeed{table: table, rows: buf.Bytes()})
		}
	}
	return seeds, nil
}

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	return testServerWith(t, testPool(t), Options{AllowedOrigin: "http://example.test"})
}

func testServerWith(t *testing.T, pool *pgxpool.Pool, opts Options) *httptest.Server {
	t.Helper()
	// The notification listener has to be bounded or it outlives the test.
	if opts.Context == nil {
		opts.Context = testContext(t)
	}
	handler := Router(pool, opts)
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})
	return srv
}

// testContext bounds background work (the cross-replica notification listener)
// to the life of the test, so it does not outlive the pool it borrows from.
func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

func postMe(t *testing.T, srv *httptest.Server, name string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

func postMeFrom(t *testing.T, srv *httptest.Server, name, forwardedFor string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"`+name+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func sessionCookieOf(t *testing.T, resp *http.Response) *http.Cookie {
	t.Helper()
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			return c
		}
	}
	t.Fatal("no session cookie set")
	return nil
}

func getMe(t *testing.T, srv *httptest.Server, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/me", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

func TestCreateThenRefreshKeepsIdentity(t *testing.T) {
	srv := testServer(t)

	resp, created := postMe(t, srv, "Ada", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d", resp.StatusCode)
	}
	cookie := sessionCookieOf(t, resp)
	if !cookie.HttpOnly || cookie.Path != "/" {
		t.Fatalf("cookie attributes wrong: %+v", cookie)
	}

	resp2, me := getMe(t, srv, cookie)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("get me: got %d", resp2.StatusCode)
	}
	if me["id"] != created["id"] || me["name"] != "Ada" {
		t.Fatalf("identity not preserved: created=%v me=%v", created, me)
	}
}

func TestForgedCookieRejected(t *testing.T) {
	srv := testServer(t)

	forged := &http.Cookie{Name: sessionCookie, Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
	resp, body := getMe(t, srv, forged)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forged cookie: got %d, want 401", resp.StatusCode)
	}
	if body["error"] != "session ended" {
		t.Fatalf("forged cookie error: got %v, want session ended", body["error"])
	}
}

func TestNoCookieIsNotSignedIn(t *testing.T) {
	srv := testServer(t)

	resp, body := getMe(t, srv, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no cookie: got %d, want 401", resp.StatusCode)
	}
	if body["error"] != "not signed in" {
		t.Fatalf("no cookie error: got %v, want not signed in", body["error"])
	}
}

func TestRenamePreservesIDAndRotatesToken(t *testing.T) {
	srv := testServer(t)

	resp, created := postMe(t, srv, "Ada", nil)
	oldCookie := sessionCookieOf(t, resp)

	resp2, renamed := postMe(t, srv, "Grace", oldCookie)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("rename: got %d", resp2.StatusCode)
	}
	if renamed["id"] != created["id"] {
		t.Fatalf("rename minted a new user: %v vs %v", renamed["id"], created["id"])
	}
	newCookie := sessionCookieOf(t, resp2)
	if newCookie.Value == oldCookie.Value {
		t.Fatal("token was not rotated on rename")
	}

	if resp3, _ := getMe(t, srv, oldCookie); resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old token still valid after rotation: got %d", resp3.StatusCode)
	}
	if resp4, me := getMe(t, srv, newCookie); resp4.StatusCode != http.StatusOK || me["name"] != "Grace" {
		t.Fatalf("new token invalid after rename: %d %v", resp4.StatusCode, me)
	}
}

func TestLogoutInvalidatesToken(t *testing.T) {
	srv := testServer(t)

	resp, _ := postMe(t, srv, "Ada", nil)
	cookie := sessionCookieOf(t, resp)

	req, _ := http.NewRequest("DELETE", srv.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp2, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: got %d", resp2.StatusCode)
	}

	if resp3, _ := getMe(t, srv, cookie); resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token still valid after logout: got %d", resp3.StatusCode)
	}
}

func TestLogoutReportsTokenDeletionFailure(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://unused:unused@127.0.0.1/unused")
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()

	a := &app{users: &store.Users{Pool: pool}, hub: hub.New()}
	t.Cleanup(a.hub.Shutdown)
	plain, _ := store.NewToken()
	req := httptest.NewRequest(http.MethodDelete, "/api/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: plain})
	rec := httptest.NewRecorder()

	a.handleDeleteMe(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("logout after token deletion failure = %d, want 500", rec.Code)
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == sessionCookie && cookie.MaxAge < 0 {
			t.Fatal("logout cleared the browser cookie after database revocation failed")
		}
	}
}

func TestNameValidation(t *testing.T) {
	srv := testServer(t)

	if resp, _ := postMe(t, srv, "", nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty name: got %d", resp.StatusCode)
	}
	if resp, _ := postMe(t, srv, strings.Repeat("x", 65), nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("65-char name: got %d", resp.StatusCode)
	}
}

func TestNonJSONBodyRejected(t *testing.T) {
	srv := testServer(t)

	req, _ := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader("name=Ada"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("form post: got %d, want 415", resp.StatusCode)
	}
}

func TestOversizedJSONBodyReturnsPayloadTooLarge(t *testing.T) {
	a := &app{authMode: ModeOpen}
	req := httptest.NewRequest(http.MethodPost, "/api/me", strings.NewReader(`{"name":"`+strings.Repeat("x", 64<<10)+`"}`))
	rec := httptest.NewRecorder()

	a.handlePostMe(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized JSON status = %d, want 413", rec.Code)
	}
}

func TestOpenIdentityCreationEnforcesPerClientHourlyLimit(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin: "http://example.test",
		Limits:        Limits{IdentityIPHourly: 2, IdentityGlobalHourly: 20},
	})
	for i := 0; i < 2; i++ {
		if resp := postMeFrom(t, srv, "Allowed", ""); resp.StatusCode != http.StatusCreated {
			t.Fatalf("creation %d = %d, want 201", i+1, resp.StatusCode)
		}
	}
	resp := postMeFrom(t, srv, "Blocked", "")
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("exhausted client limit = %d, want 429", resp.StatusCode)
	}
	retryAfter, err := strconv.Atoi(resp.Header.Get("Retry-After"))
	if err != nil || retryAfter < 1 || retryAfter > 3600 {
		t.Fatalf("Retry-After = %q, want seconds until the hourly reset", resp.Header.Get("Retry-After"))
	}
}

func TestOpenIdentityCreationEnforcesGlobalHourlyLimit(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin:     "http://example.test",
		TrustProxyHeaders: true,
		TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")},
		Limits:            Limits{IdentityIPHourly: 20, IdentityGlobalHourly: 2},
	})
	for i, addr := range []string{"198.51.100.1", "198.51.100.2"} {
		if resp := postMeFrom(t, srv, "Allowed", addr); resp.StatusCode != http.StatusCreated {
			t.Fatalf("creation %d = %d, want 201", i+1, resp.StatusCode)
		}
	}
	if resp := postMeFrom(t, srv, "Blocked", "198.51.100.3"); resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("exhausted global limit = %d, want 429", resp.StatusCode)
	}
}

func TestConcurrentOpenIdentityCreationCannotExceedClientLimit(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{
		AllowedOrigin: "http://example.test",
		Limits:        Limits{IdentityIPHourly: 3, IdentityGlobalHourly: 20},
	})

	const attempts = 12
	statuses := concurrentStatuses(t, attempts, func(i int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/me", fmt.Sprintf(`{"name":"Person %d"}`, i), nil)
	})
	created := 0
	for _, status := range statuses {
		if status == http.StatusCreated {
			created++
		} else if status != http.StatusTooManyRequests {
			t.Fatalf("concurrent creation status = %d, want 201 or 429", status)
		}
	}
	if created != 3 {
		t.Fatalf("created %d identities, want exactly 3", created)
	}
	var stored int
	if err := pool.QueryRow(context.Background(), "select count(*) from users").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 3 {
		t.Fatalf("stored %d identities, want exactly 3", stored)
	}
}
