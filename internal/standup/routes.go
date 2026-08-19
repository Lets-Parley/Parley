package standup

import (
	"encoding/json"
	"net/http"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// actions is standup's dispatch table. Membership, the facilitator check and
// the ended-session guard all run in the core dispatcher before any of these
// are called, so none of them re-check authorization.
func actions() map[string]session.Action {
	return map[string]session.Action{
		"standup": {Do: putEntry},
		"start":   {Do: start, FacilitatorOnly: true},
		"next":    {Do: next, FacilitatorOnly: true},
		"skip":    {Do: skip, FacilitatorOnly: true},
	}
}

func done(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	(&store.Sessions{Pool: ac.Pool}).BumpVersion(r.Context(), ac.Session.ID)
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}

func putEntry(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		Yesterday string `json:"yesterday"`
		Today     string `json:"today"`
		Blockers  string `json:"blockers"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	if len(body.Yesterday) > 2000 || len(body.Today) > 2000 || len(body.Blockers) > 2000 {
		http.Error(w, `{"error":"each field can be at most 2000 characters"}`, http.StatusBadRequest)
		return
	}
	_, err := ac.Pool.Exec(r.Context(), `
		insert into standup_entries (session_id, user_id, yesterday, today, blockers, position)
		values ($1, $2, $3, $4, $5,
		        (select coalesce(max(position), 0) + 1 from standup_entries where session_id = $1))
		on conflict (session_id, user_id) do update
		set yesterday = excluded.yesterday, today = excluded.today,
		    blockers = excluded.blockers, updated_at = now()`,
		ac.Session.ID, ac.UserID, body.Yesterday, body.Today, body.Blockers)
	if err != nil {
		http.Error(w, `{"error":"could not save your update"}`, http.StatusInternalServerError)
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

	tx, err := ac.Pool.Begin(r.Context())
	if err != nil {
		http.Error(w, `{"error":"could not start the standup"}`, http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(), "select 1 from sessions where id = $1 for update", ac.Session.ID); err != nil {
		http.Error(w, `{"error":"could not start the standup"}`, http.StatusInternalServerError)
		return
	}

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
		ac.Session.ID, ac.Session.SpaceID, connected); err != nil {
		http.Error(w, `{"error":"could not start the standup"}`, http.StatusInternalServerError)
		return
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
		ac.Session.ID, ac.Session.SpaceID); err != nil {
		http.Error(w, `{"error":"could not start the standup"}`, http.StatusInternalServerError)
		return
	}

	if _, err := tx.Exec(r.Context(), `
		update sessions set phase = 'speaking', version = version + 1, speaker_started_at = now(),
		current_speaker_id = (
		    select e.user_id from standup_entries e
		    join members m on m.space_id = $2 and m.user_id = e.user_id
		    where e.session_id = $1 and not m.spectator
		    order by e.position limit 1)
		where id = $1`, ac.Session.ID, ac.Session.SpaceID); err != nil {
		http.Error(w, `{"error":"could not start the standup"}`, http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, `{"error":"could not start the standup"}`, http.StatusInternalServerError)
		return
	}

	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}

func advance(w http.ResponseWriter, r *http.Request, ac session.ActionCtx, markSkipped bool) {
	if markSkipped {
		ac.Pool.Exec(r.Context(), `
			update standup_entries set skipped = true
			where session_id = $1 and user_id = (select current_speaker_id from sessions where id = $1)`,
			ac.Session.ID)
	}
	// Next entry after the current speaker's position; none left → done.
	tag, _ := ac.Pool.Exec(r.Context(), `
		update sessions set version = version + 1, speaker_started_at = now(),
		current_speaker_id = (
		    select e.user_id from standup_entries e
		    join members m on m.space_id = $2 and m.user_id = e.user_id
		    where e.session_id = $1 and not m.spectator and e.position > coalesce((
		        select position from standup_entries
		        where session_id = $1 and user_id = sessions.current_speaker_id), 0)
		    order by e.position limit 1)
		where id = $1 and phase = 'speaking'`, ac.Session.ID, ac.Session.SpaceID)
	if tag.RowsAffected() == 0 {
		http.Error(w, `{"error":"the standup has not started"}`, http.StatusConflict)
		return
	}
	ac.Pool.Exec(r.Context(), `
		update sessions set phase = 'done', speaker_started_at = null
		where id = $1 and current_speaker_id is null`, ac.Session.ID)
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}

func next(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	advance(w, r, ac, false)
}

func skip(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	advance(w, r, ac, true)
}
