package poker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// actions is poker's dispatch table. Membership, the facilitator check and the
// ended-session guard all run in the core dispatcher before any of these are
// called, so none of them re-check authorization.
func actions() map[string]session.Action {
	return map[string]session.Action{
		"stories": {Do: addStory, FacilitatorOnly: true},
		"select":  {Do: selectStory, FacilitatorOnly: true},
		"reveal":  {Do: reveal, FacilitatorOnly: true},
		"reset":   {Do: reset, FacilitatorOnly: true},
		"story":   {Do: patchStory, FacilitatorOnly: true},
		"vote":    {Do: vote},
	}
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, into); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return false
	}
	return true
}

func committed(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}

var (
	errInvalidEstimate   = errors.New("invalid estimate")
	errStoryNotInSession = errors.New("story not in session")
	errVotesRevealed     = errors.New("votes revealed")
	errNotCurrentStory   = errors.New("story not current")
	errSpectator         = errors.New("spectator")
	errInvalidVote       = errors.New("invalid vote")
)

func writeMutationError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, store.ErrNotFacilitator):
		http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
	case errors.Is(err, store.ErrSessionEnded):
		http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
	case errors.Is(err, store.ErrQuotaExceeded):
		http.Error(w, `{"error":"story limit reached for this session"}`, http.StatusConflict)
	default:
		http.Error(w, `{"error":"`+fallback+`"}`, http.StatusInternalServerError)
	}
}

// storyIn binds a story id from the request body to the session in the path.
// A story belonging to another session is not addressable under this path at
// all, so a mismatch reads the same as a story that does not exist. Without
// this, a member of two sessions could reach into either one from the other's
// URL and the path's authorization would say nothing about it.
func storyIn(ctx context.Context, pool *pgxpool.Pool, sessionID, storyID string) bool {
	var owner string
	if err := pool.QueryRow(ctx,
		"select session_id::text from stories where id = $1", storyID).Scan(&owner); err != nil {
		return false
	}
	return owner == sessionID
}

func addStory(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		Title string `json:"title"`
		Notes string `json:"notes"`
		Ref   string `json:"ref"`
	}
	if !decode(w, r, &body) {
		return
	}
	title := strings.TrimSpace(body.Title)
	ref := strings.TrimSpace(body.Ref)
	if title == "" || len(title) > 200 || len(body.Notes) > 2000 {
		http.Error(w, `{"error":"title must be 1-200 characters, notes at most 2000"}`, http.StatusBadRequest)
		return
	}
	if len(ref) > 40 {
		http.Error(w, `{"error":"a ticket reference can be at most 40 characters"}`, http.StatusBadRequest)
		return
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, _ store.Session) error {
			var count int
			if err := tx.QueryRow(r.Context(), "select count(*) from stories where session_id = $1", ac.Session.ID).Scan(&count); err != nil {
				return err
			}
			if ac.StoryLimit > 0 && count >= ac.StoryLimit {
				return store.ErrQuotaExceeded
			}
			if _, err := tx.Exec(r.Context(), `
				insert into stories (session_id, title, notes, ref, position)
				values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from stories where session_id = $1))`,
				ac.Session.ID, title, body.Notes, ref); err != nil {
				return err
			}
			_, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", ac.Session.ID)
			return err
		})
	if err != nil {
		writeMutationError(w, err, "could not add story")
		return
	}
	committed(w, r, ac)
}

// patchBody is shared with the legacy PATCH /stories/{id} alias, which takes
// the story from the path and ignores StoryID.
type patchBody struct {
	StoryID  string   `json:"storyId"`
	Title    *string  `json:"title"`
	Notes    *string  `json:"notes"`
	Ref      *string  `json:"ref"`
	Position *float64 `json:"position"`
	Estimate *string  `json:"estimate"`
}

func patchStory(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body patchBody
	if !decode(w, r, &body) {
		return
	}
	if !storyIn(r.Context(), ac.Pool, ac.Session.ID, body.StoryID) {
		http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
		return
	}
	applyPatch(w, r, ac, body.StoryID, body)
}

func applyPatch(w http.ResponseWriter, r *http.Request, ac session.ActionCtx, storyID string, body patchBody) {
	var title *string
	if body.Title != nil {
		t := strings.TrimSpace(*body.Title)
		if t == "" || len(t) > 200 {
			http.Error(w, `{"error":"title must be 1-200 characters"}`, http.StatusBadRequest)
			return
		}
		title = &t
	}
	if body.Notes != nil {
		if len(*body.Notes) > 2000 {
			http.Error(w, `{"error":"notes can be at most 2000 characters"}`, http.StatusBadRequest)
			return
		}
	}
	var ref *string
	if body.Ref != nil {
		trimmed := strings.TrimSpace(*body.Ref)
		if len(trimmed) > 40 {
			http.Error(w, `{"error":"a ticket reference can be at most 40 characters"}`, http.StatusBadRequest)
			return
		}
		ref = &trimmed
	}
	var estimate *string
	if body.Estimate != nil {
		est := strings.TrimSpace(*body.Estimate)
		estimate = &est
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, sess store.Session) error {
			if title != nil {
				if _, err := tx.Exec(r.Context(), "update stories set title = $2 where id = $1", storyID, *title); err != nil {
					return err
				}
			}
			if body.Notes != nil {
				if _, err := tx.Exec(r.Context(), "update stories set notes = $2 where id = $1", storyID, *body.Notes); err != nil {
					return err
				}
			}
			if ref != nil {
				if _, err := tx.Exec(r.Context(), "update stories set ref = $2 where id = $1", storyID, *ref); err != nil {
					return err
				}
			}
			if body.Position != nil {
				if _, err := tx.Exec(r.Context(), "update stories set position = $2 where id = $1", storyID, *body.Position); err != nil {
					return err
				}
			}
			if estimate != nil {
				if *estimate == "" {
					if _, err := tx.Exec(r.Context(), "update stories set estimate = null, status = 'pending' where id = $1", storyID); err != nil {
						return err
					}
				} else {
					var cfg Config
					json.Unmarshal(sess.Config, &cfg)
					deck, ok := DeckByName(cfg.Deck)
					if !ok {
						deck, _ = DeckByName("fibonacci")
					}
					if !deck.Has(*estimate) || isSpecial(*estimate) {
						return errInvalidEstimate
					}
					if _, err := tx.Exec(r.Context(), "update stories set estimate = $2, status = 'estimated' where id = $1", storyID, *estimate); err != nil {
						return err
					}
				}
			}
			_, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", sess.ID)
			return err
		})
	if errors.Is(err, errInvalidEstimate) {
		http.Error(w, `{"error":"an estimate has to be a card from this session's deck"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		writeMutationError(w, err, "could not update story")
		return
	}
	committed(w, r, ac)
}

func selectStory(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		StoryID string `json:"storyId"`
	}
	if !decode(w, r, &body) {
		return
	}
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, _ store.Session) error {
			tag, err := tx.Exec(r.Context(), `
				update sessions set current_story_id = $2, revealed = false, version = version + 1
				where id = $1 and exists (select 1 from stories where id = $2 and session_id = $1)`,
				ac.Session.ID, body.StoryID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errStoryNotInSession
			}
			_, err = tx.Exec(r.Context(),
				"update stories set status = 'voting' where id = $1 and status = 'pending'", body.StoryID)
			return err
		})
	if errors.Is(err, errStoryNotInSession) {
		http.Error(w, `{"error":"that story is not in this session"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		writeMutationError(w, err, "could not select story")
		return
	}
	committed(w, r, ac)
}

// voteBody is shared with the legacy POST /stories/{id}/vote alias.
type voteBody struct {
	StoryID string `json:"storyId"`
	Value   string `json:"value"`
}

func vote(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body voteBody
	if !decode(w, r, &body) {
		return
	}
	if !storyIn(r.Context(), ac.Pool, ac.Session.ID, body.StoryID) {
		http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
		return
	}
	castVote(w, r, ac, body.StoryID, body.Value)
}

func castVote(w http.ResponseWriter, r *http.Request, ac session.ActionCtx, storyID, value string) {
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			if sess.Revealed {
				return errVotesRevealed
			}
			var currentID string
			if err := tx.QueryRow(r.Context(),
				"select coalesce(current_story_id::text,'') from sessions where id = $1", sess.ID).Scan(&currentID); err != nil {
				return err
			}
			if currentID != storyID {
				return errNotCurrentStory
			}
			var spectator bool
			if err := tx.QueryRow(r.Context(),
				"select spectator from members where space_id = $1 and user_id = $2",
				sess.SpaceID, ac.UserID).Scan(&spectator); err != nil || spectator {
				return errSpectator
			}
			var cfg Config
			json.Unmarshal(sess.Config, &cfg)
			deck, ok := DeckByName(cfg.Deck)
			if !ok {
				deck, _ = DeckByName("fibonacci")
			}
			if !deck.Has(value) {
				return errInvalidVote
			}
			if _, err := tx.Exec(r.Context(), `
				insert into votes (story_id, user_id, value) values ($1, $2, $3)
				on conflict (story_id, user_id) do update set value = excluded.value`,
				storyID, ac.UserID, value); err != nil {
				return err
			}
			if err := maybeAutoReveal(r.Context(), tx, ac.Hub, sess, storyID); err != nil {
				return err
			}
			_, err := tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", sess.ID)
			return err
		})
	switch {
	case errors.Is(err, errVotesRevealed):
		http.Error(w, `{"error":"votes are revealed — wait for the next round"}`, http.StatusConflict)
	case errors.Is(err, errNotCurrentStory):
		http.Error(w, `{"error":"voting is not open on this story"}`, http.StatusConflict)
	case errors.Is(err, errSpectator):
		http.Error(w, `{"error":"spectators cannot vote"}`, http.StatusConflict)
	case errors.Is(err, errInvalidVote):
		http.Error(w, `{"error":"that vote is not in this session's deck"}`, http.StatusConflict)
	case err != nil:
		writeMutationError(w, err, "could not record vote")
	default:
		committed(w, r, ac)
	}
}

// maybeAutoReveal fires only here, on a vote landing — never from presence
// changes, so a disconnect can shrink the denominator but can't reveal.
func maybeAutoReveal(ctx context.Context, tx pgx.Tx, h *hub.Hub, sess store.Session, storyID string) error {
	connected := h.Connected(sess.ID)
	if len(connected) == 0 {
		return nil
	}
	var exact bool
	err := tx.QueryRow(ctx, `
		with eligible as (
			select user_id from members
			where space_id = $1 and not spectator and user_id::text = any($2)
		), voters as (
			select user_id from votes where story_id = $3
		)
		select exists (select 1 from eligible)
		and not exists (select user_id from eligible except select user_id from voters)
		and not exists (select user_id from voters except select user_id from eligible)`,
		sess.SpaceID, connected, storyID).Scan(&exact)
	if err != nil || !exact {
		return err
	}
	_, err = tx.Exec(ctx, "update sessions set revealed = true where id = $1 and not revealed", sess.ID)
	return err
}

func reveal(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, _ store.Session) error {
			_, err := tx.Exec(r.Context(), "update sessions set revealed = true, version = version + 1 where id = $1", ac.Session.ID)
			return err
		})
	if err != nil {
		writeMutationError(w, err, "could not reveal votes")
		return
	}
	committed(w, r, ac)
}

func reset(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, _ store.Session) error {
			if _, err := tx.Exec(r.Context(),
				"delete from votes where story_id = (select current_story_id from sessions where id = $1)", ac.Session.ID); err != nil {
				return err
			}
			_, err := tx.Exec(r.Context(), "update sessions set revealed = false, version = version + 1 where id = $1", ac.Session.ID)
			return err
		})
	if err != nil {
		writeMutationError(w, err, "could not reset votes")
		return
	}
	committed(w, r, ac)
}
