package standup

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// mentionCall puts one mention action as userID and reports the recorder and
// how many times the room was told to refresh.
func mentionCall(t *testing.T, pool *pgxpool.Pool, sess store.Session, userID, to string, needed bool) (*httptest.ResponseRecorder, int) {
	t.Helper()
	body := `{"to":"` + to + `","needed":false}`
	if needed {
		body = `{"to":"` + to + `","needed":true}`
	}
	req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body))
	rec := httptest.NewRecorder()
	broadcasts := 0
	setMention(rec, req, session.ActionCtx{
		Pool:      pool,
		Session:   sess,
		UserID:    userID,
		Broadcast: func(context.Context, string) { broadcasts++ },
	})
	return rec, broadcasts
}

func mentionRows(t *testing.T, pool *pgxpool.Pool, sessionID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		"select count(*) from standup_mentions where session_id = $1", sessionID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A uuid is a uuid whatever its case. The caller's own id in capitals is still
// the caller, so it is the same 400 as the lower-case one — never the CHECK
// constraint surfacing as a 500.
func TestMentioningYourselfInCapitalsIsStillYourself(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor")

	rec, broadcasts := mentionCall(t, pool, sess, ids[0], strings.ToUpper(ids[0]), true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("self mention in capitals: status %d (%s), want 400", rec.Code, rec.Body.String())
	}
	if broadcasts != 0 || mentionRows(t, pool, sess.ID) != 0 {
		t.Fatalf("a refused mention wrote something: broadcasts %d rows %d", broadcasts, mentionRows(t, pool, sess.ID))
	}
}

// Withdrawing names the same person however the id is spelled.
func TestWithdrawingAMentionInCapitalsRemovesIt(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor")

	if rec, _ := mentionCall(t, pool, sess, ids[0], ids[1], true); rec.Code != http.StatusNoContent {
		t.Fatalf("mention: %d (%s)", rec.Code, rec.Body.String())
	}
	if rec, _ := mentionCall(t, pool, sess, ids[0], strings.ToUpper(ids[1]), false); rec.Code != http.StatusNoContent {
		t.Fatalf("withdraw: %d (%s)", rec.Code, rec.Body.String())
	}
	if n := mentionRows(t, pool, sess.ID); n != 0 {
		t.Fatalf("%d mention rows remain after withdrawing in capitals, want 0", n)
	}
}

// A mention that changes nothing tells nobody anything. Otherwise any member
// could make the whole room refetch at will by withdrawing a mention that was
// never there, or repeating one that already is.
func TestAMentionThatChangesNothingMovesNoVersion(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor")

	before := sessionVersion(t, pool, sess.ID)
	rec, broadcasts := mentionCall(t, pool, sess, ids[0], ids[1], false)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("withdrawing an absent mention: %d (%s), want 204", rec.Code, rec.Body.String())
	}
	if after := sessionVersion(t, pool, sess.ID); after != before || broadcasts != 0 {
		t.Fatalf("withdrawing nothing: version %d -> %d, broadcasts %d; want unchanged and 0", before, after, broadcasts)
	}

	if rec, b := mentionCall(t, pool, sess, ids[0], ids[1], true); rec.Code != http.StatusNoContent || b != 1 {
		t.Fatalf("first mention: %d, broadcasts %d; want 204 and 1", rec.Code, b)
	}
	before = sessionVersion(t, pool, sess.ID)
	rec, broadcasts = mentionCall(t, pool, sess, ids[0], ids[1], true)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("repeat mention: %d (%s), want 204", rec.Code, rec.Body.String())
	}
	if after := sessionVersion(t, pool, sess.ID); after != before || broadcasts != 0 {
		t.Fatalf("repeat mention: version %d -> %d, broadcasts %d; want unchanged and 0", before, after, broadcasts)
	}

	// A real withdrawal still moves it.
	rec, broadcasts = mentionCall(t, pool, sess, ids[0], ids[1], false)
	if rec.Code != http.StatusNoContent || broadcasts != 1 || sessionVersion(t, pool, sess.ID) != before+1 {
		t.Fatalf("withdraw: %d, broadcasts %d, version %d; want 204, 1, %d",
			rec.Code, broadcasts, sessionVersion(t, pool, sess.ID), before+1)
	}
}

// A sync standup never shows a mention, so it does not take one.
func TestASyncStandupRefusesAMention(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")

	rec, broadcasts := mentionCall(t, pool, sess, ids[0], ids[1], true)
	if rec.Code != http.StatusConflict {
		t.Fatalf("mention in a sync standup: %d (%s), want 409", rec.Code, rec.Body.String())
	}
	if broadcasts != 0 || mentionRows(t, pool, sess.ID) != 0 {
		t.Fatalf("a refused mention wrote something: broadcasts %d rows %d", broadcasts, mentionRows(t, pool, sess.ID))
	}
}

// The insert carries its own lock, independent of the handler's check: called
// directly for somebody who is not a member, or who is a link guest, or from
// somebody who is not a member, it writes nothing.
func TestTheMentionInsertRefusesOnItsOwn(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield", "Ruth Okafor", "Cal Ng")
	ctx := context.Background()

	// Cal leaves the space after any check would have passed.
	if _, err := pool.Exec(ctx, "delete from members where space_id = $1 and user_id = $2", sess.SpaceID, ids[2]); err != nil {
		t.Fatal(err)
	}
	// Ruth is turned into a link guest.
	var linkID string
	if err := pool.QueryRow(ctx, `
		insert into session_links (session_id, created_by, token_hash, expires_at)
		values ($1, $2, '\x00', now() + interval '1 day') returning id::text`, sess.ID, ids[0]).Scan(&linkID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "update users set link_id = $1 where id = $2", linkID, ids[1]); err != nil {
		t.Fatal(err)
	}

	for name, pair := range map[string][2]string{
		"to a former member":   {ids[0], ids[2]},
		"to a link guest":      {ids[0], ids[1]},
		"from a former member": {ids[2], ids[0]},
	} {
		var inserted bool
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			var err error
			inserted, err = insertMention(ctx, tx, sess.SpaceID, sess.ID, pair[0], pair[1])
			return err
		})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if inserted {
			t.Errorf("%s: the insert reports a row written", name)
		}
	}
	if n := mentionRows(t, pool, sess.ID); n != 0 {
		t.Fatalf("%d mention rows written past the statement's own guard, want 0", n)
	}
}

// Once a standup has ended its record keeps its entries only: what it changed
// is not served, so a per-person landed and dropped history cannot be rebuilt
// from old rooms.
func TestAnEndedStandupServesNoChanges(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{"mode":"async"}`, "Dana Whitfield")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		insert into standup_commitments (space_id, user_id, text, opened_session_id, closed_at, closed_session_id, closed_reason)
		values ($1, $2, 'ship the importer', $3, now(), $3, 'dropped')`, sess.SpaceID, ids[0], sess.ID); err != nil {
		t.Fatal(err)
	}
	if got := buildStandupState(t, pool, sess).Changes; len(got) != 1 {
		t.Fatalf("an open standup's changes = %v, want the one it moved", got)
	}

	if err := (&store.Sessions{Pool: pool}).SetEnded(ctx, sess.ID, ids[0], true); err != nil {
		t.Fatal(err)
	}
	ended, err := (&store.Sessions{Pool: pool}).ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	st := buildStandupState(t, pool, ended)
	if st.Changes == nil || len(st.Changes) != 0 {
		t.Fatalf("an ended standup's changes = %#v, want an empty list", st.Changes)
	}
}
