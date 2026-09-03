package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/store"
)

// listedSpace creates an org-visible, passcode-free space with a name that
// fixes where it sorts, and returns its slug. The directory orders by name, so
// a test that cares about page boundaries has to control the names.
func listedSpace(t *testing.T, srv *httptest.Server, pool *pgxpool.Pool, name string, cookie *http.Cookie) string {
	t.Helper()
	sp := createOpenSpace(t, srv, name, cookie)
	slug := sp["slug"].(string)
	makeOrgVisible(t, pool, slug)
	return slug
}

func pageSlugs(rows []map[string]any) []string {
	slugs := make([]string, 0, len(rows))
	for _, row := range rows {
		slugs = append(slugs, row["slug"].(string))
	}
	return slugs
}

// The directory is bounded. It is the page a new member is pointed at from the
// landing page, so it is both the first thing they load and the one most
// likely to be large; an org that has been running for a year must not be able
// to make it return every room it has.
func TestOrgDirectoryIsBoundedByDefault(t *testing.T) {
	// One identity creates more spaces than the per-identity quota allows by
	// default, so this test raises it: what is under test is the directory's
	// bound, not the creation cap.
	srv, pool := quotaServer(t, Limits{SpacesPerIdentity: store.DirectoryPageSize + 10})
	fay := signup(t, srv, "Fay")

	total := store.DirectoryPageSize + 3
	for i := range total {
		listedSpace(t, srv, pool, "Room "+strconv.Itoa(1000+i), fay)
	}

	resp, page := listOrgSpacesRaw(t, srv, "", fay)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reading the directory = %d, want 200", resp.StatusCode)
	}
	if len(page.Spaces) != store.DirectoryPageSize {
		t.Errorf("an unbounded ask returned %d spaces, want the default page of %d",
			len(page.Spaces), store.DirectoryPageSize)
	}
	if page.Next == "" {
		t.Fatal("a truncated page carries no cursor, so the rest of the org is unreachable")
	}

	// And the pages together are the whole list, exactly once each.
	_, all := listOrgSpaces(t, srv, fay)
	if len(all) != total {
		t.Errorf("walking every page returned %d spaces, want %d", len(all), total)
	}
}

// The paging rule that made this a cursor and not an offset: the set moves
// while somebody is reading it. An offset re-counts the list on every request,
// so a space inserted ahead of the reader pushes a row across the boundary and
// it is never seen, and one removed behind them shows a row twice. A keyset on
// (name, slug) asks for "the rows after this one", which neither insertion nor
// deletion can change the meaning of.
func TestOrgDirectoryPagingSurvivesAChangingSet(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fay := signup(t, srv, "Fay")

	bee := listedSpace(t, srv, pool, "Bbb", fay)
	listedSpace(t, srv, pool, "Ccc", fay)
	dee := listedSpace(t, srv, pool, "Ddd", fay)
	eee := listedSpace(t, srv, pool, "Eee", fay)

	resp, first := listOrgSpacesRaw(t, srv, "limit=2", fay)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the first page = %d, want 200", resp.StatusCode)
	}
	if got := len(first.Spaces); got != 2 {
		t.Fatalf("limit=2 returned %d spaces", got)
	}
	if first.Next == "" {
		t.Fatal("the first of three pages carries no cursor")
	}

	// A space inserted ahead of everything already read. An offset paginator
	// would now hand back a row from the first page and lose the last one;
	// a keyset asks for what follows Ccc, which this cannot change.
	listedSpace(t, srv, pool, "Aaa", fay)

	_, second := listOrgSpacesRaw(t, srv, "limit=2&after="+url.QueryEscape(first.Next), fay)
	got := pageSlugs(second.Spaces)
	if len(got) != 2 || got[0] != dee || got[1] != eee {
		t.Errorf("the page after an insertion ahead of the reader = %v, want [%s %s] — nothing skipped and nothing repeated",
			got, dee, eee)
	}
	if second.Next != "" {
		t.Errorf("the last page carries a cursor %q, so a client would ask for a page that is not there", second.Next)
	}

	// And the other direction: a row the reader has already been handed goes
	// away behind them. The cursor names a position rather than a count, so
	// the page after it is the same page it was.
	if _, err := pool.Exec(ctx,
		"update spaces set archived_at = now() where slug = $1", bee); err != nil {
		t.Fatal(err)
	}
	_, again := listOrgSpacesRaw(t, srv, "limit=2&after="+url.QueryEscape(first.Next), fay)
	if got := pageSlugs(again.Spaces); len(got) != 2 || got[0] != dee || got[1] != eee {
		t.Errorf("the page after a deletion behind the reader = %v, want [%s %s]", got, dee, eee)
	}
}

// A cursor is opaque, so one this build did not mint is refused rather than
// read as "start from the top": silently restarting would look to a client
// like the list had reset under it. A limit that is not a positive number is
// refused for the same reason — it is a client bug, and answering the default
// hides it.
func TestOrgDirectoryRefusesJunkPagingParameters(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fay := signup(t, srv, "Fay")
	listedSpace(t, srv, pool, "Only Room", fay)

	for _, query := range []string{"after=not-a-cursor", "after=" + url.QueryEscape("bmFtZQ"), "limit=0", "limit=-4", "limit=lots"} {
		if resp, _ := listOrgSpacesRaw(t, srv, query, fay); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("GET the directory with %q = %d, want 400", query, resp.StatusCode)
		}
	}

	// An over-large limit is not a client error: the bound is the server's
	// promise about its own work, so it is clamped and answered.
	if resp, page := listOrgSpacesRaw(t, srv, "limit=100000", fay); resp.StatusCode != http.StatusOK || len(page.Spaces) != 1 {
		t.Errorf("an over-large limit = %d with %d spaces, want 200 and 1", resp.StatusCode, len(page.Spaces))
	}
}

// Archiving takes a space out of the directory and does nothing else. That has
// to hold page by page: a paginated query that forgot the filter would hide it
// from the first page and hand it over on the second.
func TestOrgDirectoryHidesArchivedSpacesOnEveryPage(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fay := signup(t, srv, "Fay")

	listedSpace(t, srv, pool, "Aaa Kept", fay)
	gone := listedSpace(t, srv, pool, "Zzz Archived", fay)
	if _, err := pool.Exec(ctx,
		"update spaces set archived_at = now() where slug = $1", gone); err != nil {
		t.Fatal(err)
	}

	_, all := listOrgSpacesPaged(t, srv, fay, 1)
	for _, slug := range pageSlugs(all) {
		if slug == gone {
			t.Errorf("an archived space is listed in the directory: %v", pageSlugs(all))
		}
	}
}

// noIndexScanPool is testPool with sequential scans forced on every
// connection. spaces_org_directory_idx is on (org_id, name, slug), so a keyset
// page with a LIMIT usually rides it for "order by name" and gets the right
// (name, slug) tie-break as a side effect of the index's own physical order —
// which would let a missing `, sp.slug` in Spaces.ForOrg's ORDER BY hide
// behind the query planner's mood instead of failing on its own merits. This
// forces the plan the ORDER BY clause is actually answerable for: a
// sequential scan feeding an explicit Sort, so a sort key of name alone
// breaks ties in scan order and not slug order.
func noIndexScanPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "set enable_indexscan = off; set enable_bitmapscan = off")
		return err
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	resetSchema(t)
	return pool
}

// directSpace inserts an org-visible, passcode-free space straight into the
// table, bypassing handleCreateSpace so the test controls the physical
// insertion order exactly. A rename (an UPDATE) would move the row's tuple to
// wherever the table has room and make that order unpredictable — a plain
// INSERT does not.
func directSpace(t *testing.T, pool *pgxpool.Pool, orgID, slug, name string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"insert into spaces (org_id, slug, name, passcode, visibility) values ($1, $2, $3, '', $4)",
		orgID, slug, name, store.VisibilityOrg); err != nil {
		t.Fatal(err)
	}
}

// The keyset orders by (name, slug), not name alone, because names are not
// unique inside an org — handleRenameSpace can put two spaces on the same
// name, and migration 0025's own comment says slug is in the key for exactly
// that reason: without it the cursor cannot name a single row, and a
// one-row-at-a-time walk past two identically-named spaces can skip or repeat
// whichever one the tie-break puts second.
func TestOrgDirectoryPagesSpacesWithIdenticalNames(t *testing.T) {
	ctx := context.Background()
	pool := noIndexScanPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fay := signup(t, srv, "Fay")

	org, err := (&store.Orgs{Pool: pool}).Default(ctx)
	if err != nil {
		t.Fatal(err)
	}

	leader := listedSpace(t, srv, pool, "Aaa Leader", fay)
	twinB, twinA := "twins-zzzzz", "twins-aaaaa"
	directSpace(t, pool, org.ID, twinB, "Twins")
	directSpace(t, pool, org.ID, twinA, "Twins")

	_, rows := listOrgSpacesPaged(t, srv, fay, 1)
	counts := map[string]int{}
	for _, slug := range pageSlugs(rows) {
		counts[slug]++
	}
	for _, slug := range []string{leader, twinA, twinB} {
		if counts[slug] != 1 {
			t.Errorf("space %q appeared %d times across a limit=1 walk past two identically-named spaces, want exactly 1", slug, counts[slug])
		}
	}
}
