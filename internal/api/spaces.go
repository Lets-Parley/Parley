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
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarHue int    `json:"avatarHue"`
	Spectator bool   `json:"spectator"`
}

func (a *app) handleCreateSpace(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	var body struct {
		Name string `json:"name"`
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

	sp, err := a.spaces.Create(r.Context(), name, slug)
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
	writeJSON(w, http.StatusCreated, sp)
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
			views := make([]memberView, len(roster))
			for i, m := range roster {
				views[i] = memberView{UserID: m.UserID, Name: m.Name, AvatarHue: avatarHue(m.UserID), Spectator: m.Spectator}
			}
			sessions, err := a.sessions.ListBySpace(r.Context(), sp.ID)
			if err != nil {
				http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"slug": sp.Slug, "name": sp.Name, "members": views, "sessions": sessions,
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"slug": sp.Slug, "name": sp.Name})
}

func (a *app) handleJoinSpace(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	sp, err := a.spaces.BySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	if err := a.spaces.Join(r.Context(), sp.ID, p.UserID); err != nil {
		http.Error(w, `{"error":"could not join space"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
