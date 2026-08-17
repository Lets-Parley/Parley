package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/jacorbello/parley/internal/store"
)

type sessionKey struct{}

func sessionFrom(ctx context.Context) store.Session {
	return ctx.Value(sessionKey{}).(store.Session)
}

// requireSessionMember resolves {id} to a session and requires the caller to be
// a member of its space. Non-members get 404 — the resource's existence is not
// disclosed.
func (a *app) requireSessionMember(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
			return
		}
		sess, err := a.sessions.ByID(r.Context(), chi.URLParam(r, "id"))
		if errors.Is(err, store.ErrNoSession) {
			http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, `{"error":"could not load session"}`, http.StatusInternalServerError)
			return
		}
		member, err := a.spaces.IsMember(r.Context(), sess.SpaceID, p.UserID)
		if err != nil || !member {
			http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionKey{}, sess)))
	})
}

// requireFacilitator runs inside requireSessionMember.
func requireFacilitator(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := PrincipalFrom(r.Context())
		if sessionFrom(r.Context()).FacilitatorID != p.UserID {
			http.Error(w, `{"error":"only the facilitator can do that"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
