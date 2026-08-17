package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/jacorbello/parley/internal/store"
)

type memberView struct {
	UserID    string   `json:"userId"`
	Name      string   `json:"name"`
	AvatarHue int      `json:"avatarHue"`
	Spectator bool     `json:"spectator"`
	At        *seatRef `json:"at,omitempty"`
}

// seatRef says which live session in this space a member currently has open, so
// the roster can offer "go to where they are". It never names a session outside
// the space, and the roster it rides on is members-only already.
type seatRef struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
}

func (a *app) handleCreateSpace(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	var body struct {
		Name string `json:"name"`
		// Open opts out of the room code; the default is a protected space.
		Open bool `json:"open"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 64 {
		http.Error(w, `{"error":"name must be 1-64 characters"}`, http.StatusBadRequest)
		return
	}
	slug := store.Slugify(name)
	if slug == "" {
		http.Error(w, `{"error":"name must contain at least one letter or number"}`, http.StatusBadRequest)
		return
	}

	passcode := ""
	if !body.Open {
		passcode = newPasscode()
	}

	sp, err := a.spaces.Create(r.Context(), name, slug, passcode)
	if errors.Is(err, store.ErrSlugTaken) {
		http.Error(w, `{"error":"that space name is taken — pick another"}`, http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not create space"}`, http.StatusInternalServerError)
		return
	}
	// The creator is the first member.
	if err := a.spaces.Join(r.Context(), sp.ID, p.UserID); err != nil {
		http.Error(w, `{"error":"could not join space"}`, http.StatusInternalServerError)
		return
	}
	// The creator is the one person who has to see the code straight away.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": sp.ID, "slug": sp.Slug, "name": sp.Name,
		"passcode": sp.Passcode, "protected": sp.Passcode != "",
	})
}

// handleGetSpace returns name only to non-members; roster requires membership.
func (a *app) handleGetSpace(w http.ResponseWriter, r *http.Request) {
	sp, err := a.spaces.BySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}

	if p, ok := PrincipalFrom(r.Context()); ok {
		if member, err := a.spaces.IsMember(r.Context(), sp.ID, p.UserID); err == nil && member {
			roster, err := a.spaces.Roster(r.Context(), sp.ID)
			if err != nil {
				http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
				return
			}
			sessions, err := a.sessions.ListBySpace(r.Context(), sp.ID)
			if err != nil {
				http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
				return
			}
			// Presence is read from the hub, not the database: a member is
			// "at" a session only while a socket is actually open.
			seats := map[string]*seatRef{}
			for _, sess := range sessions {
				if sess.EndedAt != nil {
					continue
				}
				for _, uid := range a.hub.Connected(sess.ID) {
					if _, taken := seats[uid]; !taken {
						seats[uid] = &seatRef{SessionID: sess.ID, Title: sess.Title}
					}
				}
			}
			views := make([]memberView, len(roster))
			for i, m := range roster {
				views[i] = memberView{UserID: m.UserID, Name: m.Name, AvatarHue: avatarHue(m.UserID), Spectator: m.Spectator, At: seats[m.UserID]}
			}
			// Members can read the room code any time — passing it on is the
			// whole point of it.
			writeJSON(w, http.StatusOK, map[string]any{
				"slug": sp.Slug, "name": sp.Name, "members": views, "sessions": sessions,
				"passcode": sp.Passcode, "protected": sp.Passcode != "",
			})
			return
		}
	}

	// A stranger learns only the name and whether the door needs a code.
	writeJSON(w, http.StatusOK, map[string]any{
		"slug": sp.Slug, "name": sp.Name, "protected": sp.Passcode != "",
	})
}

func (a *app) handleJoinSpace(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	var body struct {
		Passcode string `json:"passcode"`
	}
	// Decode whatever arrives rather than trusting Content-Length: a chunked
	// request declares -1, and skipping the decode would drop a correct
	// passcode and answer 403. An absent body is simply empty.
	if err := decodeOptional(w, r, &body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}

	sp, err := a.spaces.BySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}

	// An existing member never re-presents the code — they already live here.
	member, err := a.spaces.IsMember(r.Context(), sp.ID, p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	if sp.Passcode != "" && !member {
		if !a.passcodeAttempts.allow(clientKey(r) + "|" + sp.ID) {
			http.Error(w, `{"error":"too many tries — wait a minute, then enter the passcode again"}`, http.StatusTooManyRequests)
			return
		}
		if !passcodeMatches(sp.Passcode, body.Passcode) {
			http.Error(w, `{"error":"That passcode doesn't match this space. Passcodes are 6 characters — check for a typo, or ask whoever invited you."}`, http.StatusForbidden)
			return
		}
	}

	if err := a.spaces.Join(r.Context(), sp.ID, p.UserID); err != nil {
		http.Error(w, `{"error":"could not join space"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSetPasscode rotates the room code or opens the space. Any member can do
// it: they can already read the current code and hand it to anyone.
func (a *app) handleSetPasscode(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	var body struct {
		Open bool `json:"open"`
	}
	if err := decodeOptional(w, r, &body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}

	sp, err := a.spaces.BySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	member, err := a.spaces.IsMember(r.Context(), sp.ID, p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	if !member {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}

	next := ""
	if !body.Open {
		next = newPasscode()
	}
	if err := a.spaces.SetPasscode(r.Context(), sp.ID, next); err != nil {
		http.Error(w, `{"error":"could not update the passcode"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"passcode": next, "protected": next != ""})
}
