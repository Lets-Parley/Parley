package standup

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// giveKudoCall posts one kudo action as userID and reports the recorder and
// how many times the room was told to refresh.
func giveKudoCall(t *testing.T, pool *pgxpool.Pool, sess store.Session, userID, body string) (*httptest.ResponseRecorder, int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	rec := httptest.NewRecorder()
	broadcasts := 0
	giveKudo(rec, req, session.ActionCtx{
		Pool:      pool,
		Session:   sess,
		UserID:    userID,
		KudoLimit: 500,
		Broadcast: func(context.Context, string) { broadcasts++ },
	})
	return rec, broadcasts
}

// sessionVersion is what a connected client compares against: the AC "a second
// connected client sees the kudo appear without a reload" is this number
// moving and the room being told, not a refetch.
func sessionVersion(t *testing.T, pool *pgxpool.Pool, sessionID string) int {
	t.Helper()
	var v int
	if err := pool.QueryRow(context.Background(),
		"select version from sessions where id = $1", sessionID).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// A kudo given in a standup is a kudo on the space wall — one table, one read
// path — and it carries the session it was given in.
func TestGiveKudoLandsOnTheWallAndInTheSessionState(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	before := sessionVersion(t, pool, sess.ID)

	rec, broadcasts := giveKudoCall(t, pool, sess, ids[0], `{"to":"`+ids[1]+`","text":"unstuck the deploy"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("kudo status = %d (%s), want 204", rec.Code, rec.Body.String())
	}
	if broadcasts != 1 {
		t.Fatalf("broadcasts = %d, want 1", broadcasts)
	}
	if after := sessionVersion(t, pool, sess.ID); after != before+1 {
		t.Fatalf("session version = %d, want %d", after, before+1)
	}

	wall, err := (&store.Kudos{Pool: pool}).ListForSpace(context.Background(), sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(wall) != 1 {
		t.Fatalf("wall has %d kudos, want 1", len(wall))
	}
	if wall[0].Text != "unstuck the deploy" || wall[0].FromUserID != ids[0] || wall[0].ToUserID != ids[1] {
		t.Fatalf("wall kudo = %+v, want Dana thanking Ruth for unstuck the deploy", wall[0])
	}
	if wall[0].SessionID != sess.ID {
		t.Fatalf("wall kudo sessionId = %q, want %q", wall[0].SessionID, sess.ID)
	}

	st := buildStandupState(t, pool, sess)
	if len(st.Kudos) != 1 {
		t.Fatalf("state has %d kudos, want 1", len(st.Kudos))
	}
	if st.Kudos[0].FromUserID != ids[0] || st.Kudos[0].ToUserID != ids[1] || st.Kudos[0].Text != "unstuck the deploy" {
		t.Fatalf("state kudo = %+v, want Dana thanking Ruth for unstuck the deploy", st.Kudos[0])
	}
}

// Only this session's kudos are the closing beat. One given in the space
// outside any room, and one given in another room, both stay on the wall.
func TestBuildStateCarriesOnlyThisSessionsKudos(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	kudos := &store.Kudos{Pool: pool}
	if _, err := kudos.Create(context.Background(), sess.SpaceID, ids[0], ids[1], "off the wall", "", 500); err != nil {
		t.Fatal(err)
	}
	if _, err := kudos.Create(context.Background(), sess.SpaceID, ids[1], ids[0], "in the room", sess.ID, 500); err != nil {
		t.Fatal(err)
	}

	st := buildStandupState(t, pool, sess)
	if st.Kudos == nil {
		t.Fatal("Kudos is nil; it must be an empty slice")
	}
	if len(st.Kudos) != 1 || st.Kudos[0].Text != "in the room" {
		t.Fatalf("state kudos = %+v, want only the one given in this room", st.Kudos)
	}
}

// A link guest holds a users row and speaks in the round — rosterUsers unions
// it in deliberately — but holds no members row. The action's own check is
// what refuses it: guests neither send nor receive.
func TestGiveKudoRefusesALinkGuest(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	ctx := context.Background()
	var linkID string
	if err := pool.QueryRow(ctx, `
		insert into session_links (session_id, created_by, token_hash, expires_at)
		values ($1, $2, '\x00'::bytea, now() + interval '1 hour') returning id::text`,
		sess.ID, ids[0]).Scan(&linkID); err != nil {
		t.Fatal(err)
	}
	var guestID string
	if err := pool.QueryRow(ctx,
		"insert into users (name, link_id) values ('Visiting Vic', $1) returning id::text", linkID,
	).Scan(&guestID); err != nil {
		t.Fatal(err)
	}

	rec, broadcasts := giveKudoCall(t, pool, sess, guestID, `{"to":"`+ids[1]+`","text":"nice round"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("guest kudo status = %d (%s), want 403", rec.Code, rec.Body.String())
	}
	if broadcasts != 0 {
		t.Fatalf("broadcasts = %d, want 0", broadcasts)
	}
	wall, err := (&store.Kudos{Pool: pool}).ListForSpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(wall) != 0 {
		t.Fatalf("wall has %d kudos, want none", len(wall))
	}
}

// A non-member outsider cannot receive one either, and that refusal is the
// store's.
func TestGiveKudoRefusesANonMemberRecipient(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield")
	ctx := context.Background()
	var outsiderID string
	if err := pool.QueryRow(ctx,
		"insert into users (name) values ('Outside Olu') returning id::text").Scan(&outsiderID); err != nil {
		t.Fatal(err)
	}

	rec, _ := giveKudoCall(t, pool, sess, ids[0], `{"to":"`+outsiderID+`","text":"hello"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("kudo to an outsider status = %d (%s), want 400", rec.Code, rec.Body.String())
	}
}

// Nor can a real link guest — a users row with a link_id and a session_links
// row, exactly what TestGiveKudoRefusesALinkGuest builds for the sender —
// receive one on the other side of the transaction. Guests neither send nor
// receive; the send half is proven above, this proves the receive half with
// an actual guest rather than a plain outsider.
func TestGiveKudoRefusesALinkGuestRecipient(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	ctx := context.Background()
	var linkID string
	if err := pool.QueryRow(ctx, `
		insert into session_links (session_id, created_by, token_hash, expires_at)
		values ($1, $2, '\x00'::bytea, now() + interval '1 hour') returning id::text`,
		sess.ID, ids[0]).Scan(&linkID); err != nil {
		t.Fatal(err)
	}
	var guestID string
	if err := pool.QueryRow(ctx,
		"insert into users (name, link_id) values ('Visiting Vic', $1) returning id::text", linkID,
	).Scan(&guestID); err != nil {
		t.Fatal(err)
	}

	rec, broadcasts := giveKudoCall(t, pool, sess, ids[0], `{"to":"`+guestID+`","text":"nice round"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("kudo to a link guest status = %d (%s), want 400", rec.Code, rec.Body.String())
	}
	if broadcasts != 0 {
		t.Fatalf("broadcasts = %d, want 0", broadcasts)
	}
	wall, err := (&store.Kudos{Pool: pool}).ListForSpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(wall) != 0 {
		t.Fatalf("wall has %d kudos, want none", len(wall))
	}
}

// The ended-session guard is the dispatcher's, but WithActiveSession asserts it
// again under the row lock, and that is the one a direct call meets.
func TestGiveKudoRefusesAnEndedSession(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	if _, err := pool.Exec(context.Background(),
		"update sessions set ended_at = now() where id = $1", sess.ID); err != nil {
		t.Fatal(err)
	}

	rec, _ := giveKudoCall(t, pool, sess, ids[0], `{"to":"`+ids[1]+`","text":"too late"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("ended-session kudo status = %d (%s), want 409", rec.Code, rec.Body.String())
	}
}

func TestGiveKudoValidatesTheText(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	for _, tc := range []struct {
		name string
		body string
	}{
		{"no text", `{"to":"` + "x" + `","text":"   "}`},
		{"no recipient", `{"to":"","text":"thanks"}`},
		// Runes, not bytes: 280 multi-byte characters are legal, 281 are not.
		{"over the limit", `{"to":"x","text":"` + strings.Repeat("い", 281) + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, _ := giveKudoCall(t, pool, sess, ids[0], tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d (%s), want 400", rec.Code, rec.Body.String())
			}
		})
	}

	rec, _ := giveKudoCall(t, pool, sess, ids[0],
		`{"to":"`+ids[1]+`","text":"`+strings.Repeat("い", 280)+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("280 characters status = %d (%s), want 204", rec.Code, rec.Body.String())
	}
}

// Thanking yourself is the store's refusal, surfaced as the caller's mistake.
func TestGiveKudoRefusesSelfKudo(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")

	rec, _ := giveKudoCall(t, pool, sess, ids[0], `{"to":"`+ids[0]+`","text":"good work me"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("self-kudo status = %d (%s), want 400", rec.Code, rec.Body.String())
	}
}

// The space cap is the store's, and it comes down the action context the way
// poker's story cap does.
func TestGiveKudoHonoursTheSpaceCap(t *testing.T) {
	pool := testPool(t)
	sess, ids := seed(t, pool, `{}`, "Dana Whitfield", "Ruth Okafor")
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"to":"`+ids[1]+`","text":"one too many"}`))
	rec := httptest.NewRecorder()
	giveKudo(rec, req, session.ActionCtx{
		Pool:      pool,
		Session:   sess,
		UserID:    ids[0],
		KudoLimit: 0,
		Broadcast: func(context.Context, string) {},
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("over-cap status = %d (%s), want 409", rec.Code, rec.Body.String())
	}
}
