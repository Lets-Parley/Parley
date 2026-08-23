package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/store"
)

// handleCreateSessionLink mints a signed link for this room and answers with
// the plain token. This is the only time it is ever readable: nothing stores
// it, and no list response carries one.
func (a *app) handleCreateSessionLink(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())

	plain, hash := store.NewToken()
	link, err := a.links.Create(r.Context(), sess.ID, p.UserID, hash, time.Now().Add(store.LinkLifetime), a.limits.LinksPerSession)
	if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, `{"error":"link limit reached for this room"}`, http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not create the link"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        link.ID,
		"token":     plain,
		"expiresAt": link.ExpiresAt,
	})
}

func (a *app) handleListSessionLinks(w http.ResponseWriter, r *http.Request) {
	links, err := a.links.ListForSession(r.Context(), sessionFrom(r.Context()).ID)
	if err != nil {
		http.Error(w, `{"error":"could not load the links"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": links})
}

// handleRevokeSessionLink is idempotent: revoking a link that is already
// revoked is a 204, so a retried request never reads as a failure.
func (a *app) handleRevokeSessionLink(w http.ResponseWriter, r *http.Request) {
	err := a.links.Revoke(r.Context(), sessionFrom(r.Context()).ID, chi.URLParam(r, "linkId"))
	if errors.Is(err, store.ErrNoLink) {
		http.Error(w, `{"error":"no such link"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not revoke the link"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
