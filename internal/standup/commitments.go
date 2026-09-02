package standup

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// maxCommitmentChars mirrors the column's char_length check. Characters, not
// bytes, for the same reason putEntry counts characters: a byte count rejects
// legal text in any non-ASCII script.
const maxCommitmentChars = 500

// errNoCommitment is "nothing of yours matched": an id belonging to somebody
// else, an id that never existed, or one already finished. All three are the
// same 404 on purpose — telling the caller which would be an existence oracle
// for other people's commitments.
var errNoCommitment = errors.New("no open commitment of yours with that id")

// commitmentBody is the shape every commitment action decodes. There is
// deliberately no userId in it: each action scopes on ac.UserID, which is what
// keeps one person's click off another person's row.
type commitmentBody struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Done bool   `json:"done"`
}

func decodeCommitment(w http.ResponseWriter, r *http.Request) (commitmentBody, bool) {
	var body commitmentBody
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return body, false
	}
	return body, true
}

func writeCommitmentError(w http.ResponseWriter, err error, fallback string) {
	if errors.Is(err, errNoCommitment) {
		http.Error(w, `{"error":"that commitment is not yours, or is already finished"}`, http.StatusNotFound)
		return
	}
	writeMutationError(w, err, fallback)
}

// addCommitment opens a commitment for the caller in this session's space.
//
// The text is validated here rather than left to the column's check
// constraint: a raw constraint violation comes back through
// writeMutationError's default branch as a 500, which tells the person nothing
// about the sentence they just typed.
func addCommitment(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	body, ok := decodeCommitment(w, r)
	if !ok {
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" || utf8.RuneCountInString(text) > maxCommitmentChars {
		http.Error(w, `{"error":"a commitment needs some text, and at most 500 characters"}`, http.StatusBadRequest)
		return
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			if _, err := tx.Exec(r.Context(), `
				insert into standup_commitments (space_id, user_id, text, opened_session_id)
				values ($1, $2, $3, $4)`,
				sess.SpaceID, ac.UserID, text, sess.ID); err != nil {
				return err
			}
			return bumpVersion(r, tx, sess)
		})
	if err != nil {
		writeCommitmentError(w, err, "could not add your commitment")
		return
	}
	done(w, r, ac)
}

// answerCommitment records "done" or "not yet" against one open commitment of
// the caller's. Yes closes it and it leaves the open list; no increments the
// carry count and it stays.
//
// Both statements assert rows-affected. Without that, answering somebody
// else's id — or one already closed — would match nothing and still return
// 204, telling the client the list moved when it did not.
func answerCommitment(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	body, ok := decodeCommitment(w, r)
	if !ok {
		return
	}
	if body.ID == "" {
		http.Error(w, `{"error":"which commitment?"}`, http.StatusBadRequest)
		return
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			tag, err := tx.Exec(r.Context(), `
				update standup_commitments
				set closed_session_id = case when $4 then $5::uuid else closed_session_id end,
				    carried = carried + case when $4 then 0 else 1 end
				where id = $1 and user_id = $2 and space_id = $3 and closed_session_id is null`,
				body.ID, ac.UserID, sess.SpaceID, body.Done, sess.ID)
			if err := notMine(tag, err); err != nil {
				return err
			}
			return bumpVersion(r, tx, sess)
		})
	if err != nil {
		writeCommitmentError(w, err, "could not record your answer")
		return
	}
	done(w, r, ac)
}

// removeCommitment withdraws one of the caller's open commitments. A finished
// one is left alone: it is already off the list, and deleting it would be an
// undo of somebody's answer rather than a withdrawal.
func removeCommitment(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	body, ok := decodeCommitment(w, r)
	if !ok {
		return
	}
	if body.ID == "" {
		http.Error(w, `{"error":"which commitment?"}`, http.StatusBadRequest)
		return
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			tag, err := tx.Exec(r.Context(), `
				delete from standup_commitments
				where id = $1 and user_id = $2 and space_id = $3 and closed_session_id is null`,
				body.ID, ac.UserID, sess.SpaceID)
			if err := notMine(tag, err); err != nil {
				return err
			}
			return bumpVersion(r, tx, sess)
		})
	if err != nil {
		writeCommitmentError(w, err, "could not remove your commitment")
		return
	}
	done(w, r, ac)
}

// notMine maps a write that matched nothing onto errNoCommitment, including
// the malformed-id case: an id that is not a uuid at all is simply not a
// commitment of the caller's, the way store.Links.Revoke reads 22P02.
func notMine(tag pgconn.CommandTag, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
		return errNoCommitment
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNoCommitment
	}
	return nil
}

func bumpVersion(r *http.Request, tx pgx.Tx, sess store.Session) error {
	_, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", sess.ID)
	return err
}
