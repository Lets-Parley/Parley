package standup

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// errNotMentionable is a target who is not somebody the caller can ask: not a
// member of this space, a link guest, the caller themself, or not a user id at
// all. One answer for all of them, and a 400: the picker only ever offers
// members, so anything else is a request the client should not have built.
var errNotMentionable = errors.New("only another member of this space can be mentioned")

// errMentionerNotAMember is a caller in the room but not on the team — a link
// guest. Refused before the target is looked at.
var errMentionerNotAMember = errors.New("only a member of this space can mention anyone")

// mentionable is one space member who is not a link guest. It is written into
// the insert itself as well as checked before it: the check gives the handler
// its answer, and the statement is the second lock, the way
// store.ClaimFacilitator carries its own guard, so a future caller that skips
// the check still cannot write a row naming a guest. $1 is the space, $2 the
// user.
const mentionable = `exists (
	select 1 from members m join users u on u.id = m.user_id
	where m.space_id = $1 and m.user_id = $2 and u.link_id is null)`

// errMentionInSync is a mention in a sync standup, which never shows one.
var errMentionInSync = errors.New("mentions are part of an async standup")

// canonicalUUID is the only spelling of a user id this file compares or
// writes: 8-4-4-4-12 hex, lower-cased. Postgres reads several spellings of the
// same uuid, so a raw string compared against the caller's id, or cast inside
// a statement, would let one person be two different strings.
var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// setMention records, or withdraws, the caller asking one member for help with
// a blocker in this standup. The body says which ("needed"), so a retry lands
// on the same answer.
//
// Nothing about a mention reaches buildState: that payload goes to every
// socket in the room, and "needs you" is the mentioned person's alone. The
// version bump is what tells each client to re-read its own list through
// GET /api/sessions/{id}/mentions — and it happens only when a row actually
// changed, so a repeat or a withdrawal of nothing cannot make the room refetch.
//
// The order of refusals is authorization first: a caller who is not a member
// is 403 whatever else is wrong, then a sync standup is 409, then a bad target
// is 400.
func setMention(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		To     string `json:"to"`
		Needed bool   `json:"needed"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	async, err := isAsync(ac)
	if err != nil {
		http.Error(w, `{"error":"could not read this standup's settings"}`, http.StatusInternalServerError)
		return
	}
	// Parsed once, here. Everything below uses to, never body.To.
	to := strings.ToLower(body.To)
	wellFormed := canonicalUUID.MatchString(to)
	changed := false
	err = (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			var member bool
			if err := tx.QueryRow(r.Context(), "select "+mentionable, sess.SpaceID, ac.UserID).Scan(&member); err != nil {
				return err
			}
			if !member {
				return errMentionerNotAMember
			}
			if !async {
				return errMentionInSync
			}
			if !wellFormed || to == ac.UserID {
				return errNotMentionable
			}
			if !body.Needed {
				tag, err := tx.Exec(r.Context(),
					"delete from standup_mentions where session_id = $1 and from_user_id = $2 and to_user_id = $3",
					sess.ID, ac.UserID, to)
				if err != nil {
					return err
				}
				if tag.RowsAffected() == 0 {
					return nil
				}
				changed = true
				return bumpVersion(r, tx, sess)
			}
			var target bool
			if err := tx.QueryRow(r.Context(), "select "+mentionable, sess.SpaceID, to).Scan(&target); err != nil {
				return err
			}
			if !target {
				return errNotMentionable
			}
			inserted, err := insertMention(r.Context(), tx, sess.SpaceID, sess.ID, ac.UserID, to)
			if err != nil {
				return err
			}
			if !inserted {
				// Either the mention was already there, which is a success
				// that changes nothing, or a guard in the statement refused.
				var exists bool
				if err := tx.QueryRow(r.Context(), `select exists (
					select 1 from standup_mentions
					where session_id = $1 and from_user_id = $2 and to_user_id = $3)`,
					sess.ID, ac.UserID, to).Scan(&exists); err != nil {
					return err
				}
				if !exists {
					return errNotMentionable
				}
				return nil
			}
			changed = true
			return bumpVersion(r, tx, sess)
		})
	switch {
	case errors.Is(err, errMentionerNotAMember):
		http.Error(w, `{"error":"only members of this space can mention anyone"}`, http.StatusForbidden)
	case errors.Is(err, errMentionInSync):
		http.Error(w, `{"error":"mentions are only part of an async standup"}`, http.StatusConflict)
	case errors.Is(err, errNotMentionable):
		http.Error(w, `{"error":"you can only mention another member of this space"}`, http.StatusBadRequest)
	case err != nil:
		writeMutationError(w, err, "could not save your mention")
	case changed:
		done(w, r, ac)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// insertMention writes one mention with both parties re-checked in the
// statement itself, and reports whether a row was written. False is either a
// mention that already exists or a guard in the statement refusing; the
// caller tells the two apart. from and to must already be canonical.
func insertMention(ctx context.Context, tx pgx.Tx, spaceID, sessionID, from, to string) (bool, error) {
	tag, err := tx.Exec(ctx, `
		insert into standup_mentions (session_id, from_user_id, to_user_id)
		select $3, $4, $2
		where `+mentionable+` and exists (
			select 1 from members m join users u on u.id = m.user_id
			where m.space_id = $1 and m.user_id = $4 and u.link_id is null)
		on conflict (session_id, from_user_id, to_user_id) do nothing`,
		spaceID, to, sessionID, from)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// Mentions is one person's own view of a standup's mentions: who asked them
// for help (needsYou) and whom they asked (asked). It is served per caller,
// never broadcast. Ids only; names come off the envelope's participants.
func Mentions(ctx context.Context, pool *pgxpool.Pool, sessionID, userID string) (needsYou, asked []string, err error) {
	needsYou, asked = []string{}, []string{}
	rows, err := pool.Query(ctx, `
		select from_user_id::text, to_user_id::text from standup_mentions
		where session_id = $1 and (to_user_id = $2 or from_user_id = $2)
		order by created_at, from_user_id, to_user_id`, sessionID, userID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var from, to string
		if err := rows.Scan(&from, &to); err != nil {
			return nil, nil, err
		}
		if to == userID {
			needsYou = append(needsYou, from)
		} else {
			asked = append(asked, to)
		}
	}
	return needsYou, asked, rows.Err()
}
