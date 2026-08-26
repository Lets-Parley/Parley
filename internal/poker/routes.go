package poker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// actions is poker's dispatch table. Handlers revalidate mutable authority and
// session state inside the transaction that performs each write.
func actions() map[string]session.Action {
	return map[string]session.Action{
		"stories": {Verb: http.MethodPost, Do: addStory, FacilitatorOnly: true},
		"select":  {Verb: http.MethodPost, Do: selectStory, FacilitatorOnly: true},
		"reveal":  {Verb: http.MethodPost, Do: reveal, FacilitatorOnly: true},
		"reset":   {Verb: http.MethodPost, Do: reset, FacilitatorOnly: true},
		"story":   {Verb: http.MethodPatch, Do: patchStory},
		"vote":    {Verb: http.MethodPost, Do: vote},
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
	errStoryUnidentified = errors.New("story has neither ref nor title")
)

func writeMutationError(ctx context.Context, w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, store.ErrNotFacilitator):
		http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
	case errors.Is(err, store.ErrSessionEnded):
		http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
	case errors.Is(err, store.ErrQuotaExceeded):
		http.Error(w, `{"error":"story limit reached for this session"}`, http.StatusConflict)
	case errors.Is(err, context.Canceled) && ctx.Err() != nil:
		// A client that aborts an in-flight request is not a server fault:
		// don't amplify ERROR volume for something the server didn't do
		// wrong. The status is unchanged for now — flipping it needs its own
		// look at what clients expect back from an aborted request.
		slog.Debug(fallback, "error", err)
		http.Error(w, `{"error":"`+fallback+`"}`, http.StatusInternalServerError)
	default:
		slog.Error(fallback, "error", err)
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
	if msg := storyIdentityError(title, ref); msg != "" {
		http.Error(w, `{"error":"`+msg+`"}`, http.StatusBadRequest)
		return
	}
	if len(body.Notes) > 2000 {
		http.Error(w, `{"error":"notes can be at most 2000 characters"}`, http.StatusBadRequest)
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
		writeMutationError(r.Context(), w, err, "could not add story")
		return
	}
	committed(w, r, ac)
}

// patchBody is the story edit's body; the story it edits travels in StoryID.
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
		if len(t) > 200 {
			http.Error(w, `{"error":"title can be at most 200 characters"}`, http.StatusBadRequest)
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
			// Ref and title name the story between them, so an edit that
			// touches either is read and written as one step: checked before
			// anything is written, and applied by a single statement so the
			// row never passes through a transiently nameless state.
			if title != nil || ref != nil {
				var haveTitle, haveRef string
				if err := tx.QueryRow(r.Context(),
					"select title, ref from stories where id = $1", storyID).Scan(&haveTitle, &haveRef); err != nil {
					return err
				}
				if title != nil {
					haveTitle = *title
				}
				if ref != nil {
					haveRef = *ref
				}
				if haveTitle == "" && haveRef == "" {
					return errStoryUnidentified
				}
				if _, err := tx.Exec(r.Context(),
					"update stories set title = $2, ref = $3 where id = $1", storyID, haveTitle, haveRef); err != nil {
					return err
				}
			}
			if body.Notes != nil {
				if _, err := tx.Exec(r.Context(), "update stories set notes = $2 where id = $1", storyID, *body.Notes); err != nil {
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
	if errors.Is(err, errStoryUnidentified) {
		http.Error(w, `{"error":"a ticket needs a reference or a title"}`, http.StatusBadRequest)
		return
	}
	if errors.Is(err, errInvalidEstimate) {
		http.Error(w, `{"error":"an estimate has to be a card from this session's deck"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		writeMutationError(r.Context(), w, err, "could not update story")
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
		writeMutationError(r.Context(), w, err, "could not select story")
		return
	}
	committed(w, r, ac)
}

// voteBody is the vote's body; the story it votes on travels in StoryID.
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
	// Read before the transaction opens: presence is a separate query, and
	// holding the session row lock across it serialises every other write.
	connected, err := ac.Presence.InSession(r.Context(), ac.Session.ID)
	if err != nil {
		// Fail towards not revealing, but say so: a presence query that keeps
		// failing means rounds silently stop opening on their own.
		slog.Error("could not read presence for auto-reveal", "session", ac.Session.ID, "error", err)
		connected = nil
	}

	err = (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
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
			// Spectating is a property of a space member. A guest who joined
			// by signed link has no members row and is never a spectator: no
			// row means a plain participant, not a refusal.
			var spectator bool
			err := tx.QueryRow(r.Context(),
				"select spectator from members where space_id = $1 and user_id = $2",
				sess.SpaceID, ac.UserID).Scan(&spectator)
			if errors.Is(err, pgx.ErrNoRows) {
				spectator = false
			} else if err != nil {
				return fmt.Errorf("reading spectator flag: %w", err)
			} else if spectator {
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
			if err := maybeAutoReveal(r.Context(), tx, connected, sess, storyID); err != nil {
				return err
			}
			_, err = tx.Exec(r.Context(), "update sessions set version = version + 1 where id = $1", sess.ID)
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
		writeMutationError(r.Context(), w, err, "could not record vote")
	default:
		committed(w, r, ac)
	}

}

// maybeAutoReveal fires only here, on a vote landing — never from presence
// changes, so a disconnect can shrink the denominator but can't reveal.
//
// The connected set comes from the presence store, which sees every replica.
// Counting only the clients attached here shrinks the denominator, and a
// shrunken denominator opens the round while the rest of the table still has
// votes to cast — the one thing hidden votes must never do. It is read by the
// caller before the transaction opens: reading it here would hold the session
// row lock across another query for no reason.
func maybeAutoReveal(ctx context.Context, tx pgx.Tx, connected []string, sess store.Session, storyID string) error {
	if len(connected) == 0 {
		return nil
	}
	var exact bool
	err := tx.QueryRow(ctx, `
		with eligible as (
			select user_id from members
			where space_id = $1 and not spectator and user_id::text = any($2)
			union
			-- A guest who joined by signed link has no members row and so no
			-- spectator flag: it votes like anybody else in the room, and the
			-- round is waiting on it like anybody else. Leaving it out both
			-- shrinks the denominator, revealing while it still has a vote to
			-- cast, and puts its vote outside eligible, which fails the
			-- "voters subset of eligible" half for as long as that vote stands.
			select u.id from users u
			join session_links l on l.id = u.link_id
			where l.session_id = $4 and u.id::text = any($2)
		), voters as (
			select user_id from votes where story_id = $3
		)
		select exists (select 1 from eligible)
		and not exists (select user_id from eligible except select user_id from voters)
		and not exists (select user_id from voters except select user_id from eligible)`,
		sess.SpaceID, connected, storyID, sess.ID).Scan(&exact)
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
		writeMutationError(r.Context(), w, err, "could not reveal votes")
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
		writeMutationError(r.Context(), w, err, "could not reset votes")
		return
	}
	committed(w, r, ac)
}

// storyIdentityError reports why a story's ref/title pair is unusable, or "".
// Either field identifies the story on its own, so only a pair that is blank
// on both sides is rejected. It trims before judging, so whitespace is not
// mistaken for a name however the caller got here.
func storyIdentityError(title, ref string) string {
	title, ref = strings.TrimSpace(title), strings.TrimSpace(ref)
	switch {
	case title == "" && ref == "":
		return "a ticket needs a reference or a title"
	case len(title) > 200:
		return "a title can be at most 200 characters"
	case len(ref) > 40:
		return "a ticket reference can be at most 40 characters"
	}
	return ""
}
