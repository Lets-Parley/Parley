package poker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// actions is poker's dispatch table. Membership, the facilitator check and the
// ended-session guard all run in the core dispatcher before any of these are
// called, so none of them re-check authorization.
func actions() map[string]session.Action {
	return map[string]session.Action{
		"stories": {Do: addStory},
		"select":  {Do: selectStory, FacilitatorOnly: true},
		"reveal":  {Do: reveal, FacilitatorOnly: true},
		"reset":   {Do: reset, FacilitatorOnly: true},
		"story":   {Do: patchStory},
		"vote":    {Do: vote},
	}
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(into); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return false
	}
	return true
}

func done(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	(&store.Sessions{Pool: ac.Pool}).BumpVersion(r.Context(), ac.Session.ID)
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
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
	_, err := ac.Pool.Exec(r.Context(), `
		insert into stories (session_id, title, notes, ref, position)
		values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from stories where session_id = $1))`,
		ac.Session.ID, title, body.Notes, ref)
	if err != nil {
		http.Error(w, `{"error":"could not add story"}`, http.StatusInternalServerError)
		return
	}
	done(w, r, ac)
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
	if body.Title != nil {
		t := strings.TrimSpace(*body.Title)
		if t == "" || len(t) > 200 {
			http.Error(w, `{"error":"title must be 1-200 characters"}`, http.StatusBadRequest)
			return
		}
		ac.Pool.Exec(r.Context(), "update stories set title = $2 where id = $1", storyID, t)
	}
	if body.Notes != nil {
		if len(*body.Notes) > 2000 {
			http.Error(w, `{"error":"notes can be at most 2000 characters"}`, http.StatusBadRequest)
			return
		}
		ac.Pool.Exec(r.Context(), "update stories set notes = $2 where id = $1", storyID, *body.Notes)
	}
	if body.Ref != nil {
		ref := strings.TrimSpace(*body.Ref)
		if len(ref) > 40 {
			http.Error(w, `{"error":"a ticket reference can be at most 40 characters"}`, http.StatusBadRequest)
			return
		}
		ac.Pool.Exec(r.Context(), "update stories set ref = $2 where id = $1", storyID, ref)
	}
	if body.Position != nil {
		ac.Pool.Exec(r.Context(), "update stories set position = $2 where id = $1", storyID, *body.Position)
	}
	if body.Estimate != nil {
		// An estimate has to be a card from this session's deck. Without the
		// check, whatever the client happened to be rendering — a placeholder
		// dash, the coffee glyph — becomes the story's permanent estimate and
		// travels on into the CSV export.
		est := strings.TrimSpace(*body.Estimate)
		if est == "" {
			// An empty estimate is a clear, not an estimate of nothing.
			ac.Pool.Exec(r.Context(),
				"update stories set estimate = null, status = 'pending' where id = $1", storyID)
		} else {
			var cfg Config
			json.Unmarshal(ac.Session.Config, &cfg)
			deck, ok := DeckByName(cfg.Deck)
			if !ok {
				deck, _ = DeckByName("fibonacci")
			}
			if !deck.Has(est) || isSpecial(est) {
				http.Error(w, `{"error":"an estimate has to be a card from this session's deck"}`, http.StatusBadRequest)
				return
			}
			ac.Pool.Exec(r.Context(),
				"update stories set estimate = $2, status = 'estimated' where id = $1", storyID, est)
		}
	}
	done(w, r, ac)
}

func selectStory(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		StoryID string `json:"storyId"`
	}
	if !decode(w, r, &body) {
		return
	}
	tag, err := ac.Pool.Exec(r.Context(), `
		update sessions set current_story_id = $2, revealed = false, version = version + 1
		where id = $1 and exists (select 1 from stories where id = $2 and session_id = $1)`,
		ac.Session.ID, body.StoryID)
	if err != nil || tag.RowsAffected() == 0 {
		http.Error(w, `{"error":"that story is not in this session"}`, http.StatusBadRequest)
		return
	}
	ac.Pool.Exec(r.Context(),
		"update stories set status = 'voting' where id = $1 and status = 'pending'", body.StoryID)
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
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
	if ac.Session.Revealed {
		http.Error(w, `{"error":"votes are revealed — wait for the next round"}`, http.StatusConflict)
		return
	}
	var currentID string
	ac.Pool.QueryRow(r.Context(),
		"select coalesce(current_story_id::text,'') from sessions where id = $1", ac.Session.ID).Scan(&currentID)
	if currentID != storyID {
		http.Error(w, `{"error":"voting is not open on this story"}`, http.StatusConflict)
		return
	}
	var spectator bool
	if err := ac.Pool.QueryRow(r.Context(),
		"select spectator from members where space_id = $1 and user_id = $2",
		ac.Session.SpaceID, ac.UserID).Scan(&spectator); err != nil || spectator {
		http.Error(w, `{"error":"spectators cannot vote"}`, http.StatusConflict)
		return
	}
	var cfg Config
	json.Unmarshal(ac.Session.Config, &cfg)
	deck, ok := DeckByName(cfg.Deck)
	if !ok {
		deck, _ = DeckByName("fibonacci")
	}
	if !deck.Has(value) {
		http.Error(w, `{"error":"that vote is not in this session's deck"}`, http.StatusConflict)
		return
	}

	if _, err := ac.Pool.Exec(r.Context(), `
		insert into votes (story_id, user_id, value) values ($1, $2, $3)
		on conflict (story_id, user_id) do update set value = excluded.value`,
		storyID, ac.UserID, value); err != nil {
		http.Error(w, `{"error":"could not record vote"}`, http.StatusInternalServerError)
		return
	}

	maybeAutoReveal(r.Context(), ac.Pool, ac.Hub, ac.Session, storyID)
	done(w, r, ac)
}

// maybeAutoReveal fires only here, on a vote landing — never from presence
// changes, so a disconnect can shrink the denominator but can't reveal.
func maybeAutoReveal(ctx context.Context, pool *pgxpool.Pool, h *hub.Hub, sess store.Session, storyID string) {
	connected := h.Connected(sess.ID)
	if len(connected) == 0 {
		return
	}
	var eligible int
	if err := pool.QueryRow(ctx,
		"select count(*) from members where space_id = $1 and not spectator and user_id::text = any($2)",
		sess.SpaceID, connected).Scan(&eligible); err != nil || eligible == 0 {
		return
	}
	var voted int
	if err := pool.QueryRow(ctx,
		"select count(*) from votes where story_id = $1", storyID).Scan(&voted); err != nil {
		return
	}
	if voted >= eligible {
		pool.Exec(ctx, "update sessions set revealed = true where id = $1 and not revealed", sess.ID)
	}
}

func reveal(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	ac.Pool.Exec(r.Context(), "update sessions set revealed = true, version = version + 1 where id = $1", ac.Session.ID)
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}

func reset(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	ac.Pool.Exec(r.Context(),
		"delete from votes where story_id = (select current_story_id from sessions where id = $1)", ac.Session.ID)
	ac.Pool.Exec(r.Context(), "update sessions set revealed = false, version = version + 1 where id = $1", ac.Session.ID)
	ac.Broadcast(r.Context(), ac.Session.ID)
	w.WriteHeader(http.StatusNoContent)
}
