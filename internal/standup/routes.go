package standup

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// actions is standup's dispatch table. Membership, the facilitator check and
// the ended-session guard all run in the core dispatcher before any of these
// are called, so none of them re-check authorization.
func actions() map[string]session.Action {
	return map[string]session.Action{
		"standup": {Verb: http.MethodPut, Do: putEntry},
		// Readiness is a member signal, not a facilitator one: FacilitatorOnly
		// here would leave nobody able to say they are ready. PUT because the
		// body carries the state wanted rather than a toggle — a retried
		// request lands on the same answer.
		"ready": {Verb: http.MethodPut, Do: setReady},
		"start": {Verb: http.MethodPost, Do: start, FacilitatorOnly: true},
		"next":  {Verb: http.MethodPost, Do: next, FacilitatorOnly: true},
		"skip":  {Verb: http.MethodPost, Do: skip, FacilitatorOnly: true},
	}
}

func done(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}

func writeMutationError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, store.ErrNotFacilitator):
		http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
	case errors.Is(err, store.ErrSessionEnded):
		http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
	default:
		http.Error(w, `{"error":"`+fallback+`"}`, http.StatusInternalServerError)
	}
}

func putEntry(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		Yesterday string `json:"yesterday"`
		Today     string `json:"today"`
		Blockers  string `json:"blockers"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	if len(body.Yesterday) > 2000 || len(body.Today) > 2000 || len(body.Blockers) > 2000 {
		http.Error(w, `{"error":"each field can be at most 2000 characters"}`, http.StatusBadRequest)
		return
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			if _, err := tx.Exec(r.Context(), `
				insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
				values ($1, $2, $3, $4, $5,
				        (select coalesce(max(position), 0) + 1 from standup_entries where session_id = $1))
				on conflict (session_id, user_id) do update
				set yesterday = excluded.yesterday, today = excluded.today,
				    blockers = excluded.blockers, updated_at = now()`,
				sess.ID, ac.UserID, body.Yesterday, body.Today, body.Blockers); err != nil {
				return err
			}
			_, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", sess.ID)
			return err
		})
	if err != nil {
		writeMutationError(w, err, "could not save your update")
		return
	}
	done(w, r, ac)
}

// roundStarted reports whether the speaking order is already fixed. A standup
// sits at the empty phase until start() moves it to "speaking" and then "done".
func roundStarted(phase string) bool {
	return phase == "speaking" || phase == "done"
}

// ensureReadyEntryRow creates the caller's entry row so a readiness signal has
// somewhere to live, and does nothing at all if one already exists.
//
// It deliberately does not reuse putEntry's upsert or start's roster insert.
// putEntry serves spectators and every phase (a spectator's row is written and
// then sorted out of the round by start); start writes the whole roster in one
// set-based statement. This is the one place a row is created by a click that
// carries no text, so it is the one place that has to answer all three of the
// hazards on its own:
//
//   - position is not null with no default, so it is computed the way putEntry
//     computes it;
//   - start() prefills "yesterday" from this person's "today" in the space's
//     previous standup with `on conflict do nothing`, so a row created here
//     would silently swallow that carry-forward — it is carried forward here
//     instead, by the same query start uses;
//   - spectators are excluded, matching start, so one cannot gain a seat in the
//     rail or a blank line in the CSV by clicking ready.
//
// Callers gate this on the gathering phase: position decides who holds the mic,
// and a row inserted mid-round sorts after the current speaker, so advance()
// would hand the turn to somebody who is not in the round.
func ensureReadyEntryRow(r *http.Request, tx pgx.Tx, sess store.Session, userID string) error {
	_, err := tx.Exec(r.Context(), `
		insert into standup_entries (session_id, user_id, yesterday, position)
		select $1, m.user_id,
		       coalesce((
		           select prev.today from standup_entries prev
		           join sessions ps on ps.id = prev.session_id
		           where prev.user_id = m.user_id and ps.space_id = $2 and ps.id <> $1
		           order by ps.created_at desc limit 1
		       ), ''),
		       (select coalesce(max(position), 0) + 1 from standup_entries where session_id = $1)
		from members m
		where m.space_id = $2 and m.user_id = $3 and not m.spectator
		on conflict (session_id, user_id) do nothing`,
		sess.ID, sess.SpaceID, userID)
	return err
}

// setReady records whether the caller has finished writing their update. It is
// advisory: start() never reads it, and neither do the speaker queries or the
// CSV.
//
// The update writes `ready` and nothing else. standup_entries is keyed
// (session_id, user_id), so a conflict clause that also wrote yesterday/today/
// blockers would wipe an autosaved update with no undo and broadcast the loss
// to the room.
func setReady(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		Ready bool `json:"ready"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			// Only while everyone is still gathering, and only for a signal
			// somebody is actually raising: once the round is under way the
			// signal is display-only, and an update that matches no row is the
			// right no-op.
			if body.Ready && !roundStarted(sess.Phase) {
				if err := ensureReadyEntryRow(r, tx, sess, ac.UserID); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(r.Context(),
				"update standup_entries set ready = $3, updated_at = now() where session_id = $1 and user_id = $2",
				sess.ID, ac.UserID, body.Ready); err != nil {
				return err
			}
			_, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", sess.ID)
			return err
		})
	if err != nil {
		writeMutationError(w, err, "could not save your readiness")
		return
	}
	done(w, r, ac)
}

// start (re)snapshots the round-robin roster and puts the session at the top
// of it. Carry-forward: each person's "yesterday" is prefilled with the "today"
// they wrote in this space's most recent previous standup.
//
// Rows can already exist when this runs — somebody filled their update in
// early, or start is being run again now that a latecomer has connected — so
// the whole session is renumbered here rather than only the new rows. Ordering
// is the roster's, and it has to be recomputed over every entry: numbering only
// the new rows would either collide with the positions already taken or, if
// offset past them, leave whoever typed first sitting ahead of the roster
// order. Everything runs under a lock on the session row, so two starts racing
// each other cannot interleave and hand two people the same slot.
func start(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	// Across every replica: with a per-pod view, a standup whose participants
	// happen to be on another pod refuses to start at all.
	connected, err := ac.Presence.InSession(r.Context(), ac.Session.ID)
	if err != nil {
		http.Error(w, `{"error":"could not read who is connected"}`, http.StatusInternalServerError)
		return
	}
	if len(connected) == 0 {
		http.Error(w, `{"error":"nobody is connected yet — open the session first"}`, http.StatusConflict)
		return
	}

	err = (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, sess store.Session) error {
			// Everyone connected who is not spectating joins the round. The position
			// here is a placeholder: the renumber below assigns the real one.
			if _, err := tx.Exec(r.Context(), `
		insert into standup_entries (session_id, user_id, yesterday, position)
		select $1, m.user_id,
		       coalesce((
		           select prev.today from standup_entries prev
		           join sessions ps on ps.id = prev.session_id
		           where prev.user_id = m.user_id and ps.space_id = $2 and ps.id <> $1
		           order by ps.created_at desc limit 1
		       ), ''),
		       0
		from members m join users u on u.id = m.user_id
		where m.space_id = $2 and not m.spectator and m.user_id::text = any($3)
		on conflict (session_id, user_id) do nothing`,
				sess.ID, sess.SpaceID, connected); err != nil {
				return err
			}

			// Renumber the session into roster order. Spectators sort last so they
			// never hold a slot in front of somebody who speaks; the speaker queries
			// skip them regardless. Only position is touched, so anything already
			// written survives.
			if _, err := tx.Exec(r.Context(), `
		update standup_entries e set position = r.rn
		from (
		    select e2.user_id,
		           row_number() over (order by m.spectator, u.name, e2.user_id) as rn
		    from standup_entries e2
		    join users u on u.id = e2.user_id
		    join members m on m.space_id = $2 and m.user_id = e2.user_id
		    where e2.session_id = $1
		) r
		where e.session_id = $1 and e.user_id = r.user_id`,
				sess.ID, sess.SpaceID); err != nil {
				return err
			}

			_, err := tx.Exec(r.Context(), `
		update sessions set phase = 'speaking', version = version + 1, speaker_started_at = now(),
		current_speaker_id = (
		    select e.user_id from standup_entries e
		    join members m on m.space_id = $2 and m.user_id = e.user_id
		    where e.session_id = $1 and not m.spectator
		    order by e.position limit 1)
		where id = $1`, sess.ID, sess.SpaceID)
			return err
		})
	if err != nil {
		writeMutationError(w, err, "could not start the standup")
		return
	}
	done(w, r, ac)
}

var errNotStarted = errors.New("standup not started")

func advance(w http.ResponseWriter, r *http.Request, ac session.ActionCtx, markSkipped bool) {
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, sess store.Session) error {
			if markSkipped {
				if _, err := tx.Exec(r.Context(), `
			update standup_entries set skipped = true
			where session_id = $1 and user_id = (select current_speaker_id from sessions where id = $1)`,
					sess.ID); err != nil {
					return err
				}
			}
			// Next entry after the current speaker's position; none left → done.
			tag, err := tx.Exec(r.Context(), `
		update sessions set version = version + 1, speaker_started_at = now(),
		current_speaker_id = (
		    select e.user_id from standup_entries e
		    join members m on m.space_id = $2 and m.user_id = e.user_id
		    where e.session_id = $1 and not m.spectator and e.position > coalesce((
		        select position from standup_entries
		        where session_id = $1 and user_id = sessions.current_speaker_id), 0)
		    order by e.position limit 1)
		where id = $1 and phase = 'speaking'`, sess.ID, sess.SpaceID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errNotStarted
			}
			_, err = tx.Exec(r.Context(), `
		update sessions set phase = 'done', speaker_started_at = null
		where id = $1 and current_speaker_id is null`, sess.ID)
			return err
		})
	if errors.Is(err, errNotStarted) {
		http.Error(w, `{"error":"the standup has not started"}`, http.StatusConflict)
		return
	}
	if err != nil {
		writeMutationError(w, err, "could not advance the standup")
		return
	}
	done(w, r, ac)
}

func next(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	advance(w, r, ac, false)
}

func skip(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	advance(w, r, ac, true)
}
