package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/store"
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
		// A link guest belongs to exactly one room and no space, so its
		// binding stands in for membership — for that room and nothing else.
		// Any other room is a 404, the same answer a stranger gets.
		if !p.IsLinkGuest() {
			member, err := a.spaces.IsMember(r.Context(), sess.SpaceID, p.UserID)
			if err != nil || !member {
				http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
				return
			}
		} else if p.LinkSessionID != sess.ID {
			http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionKey{}, sess)))
	})
}

// rejectEnded runs inside requireSessionMember and turns away writes to a
// closed session. It is its own middleware rather than part of
// requireSessionMember because reading, exporting and reopening an ended
// session are all legitimate — reopen exists for nothing else.
//
// Kind actions do not use this middleware — the dispatcher in dispatch.go
// applies the same guard itself, after resolving the action, so that an
// unknown action is a 404 rather than a 409.
func rejectEnded(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sessionFrom(r.Context()).EndedAt != nil {
			http.Error(w, `{"error":"this session has ended"}`, http.StatusConflict)
			return
		}
		next.ServeHTTP(w, r)
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

type spaceKey struct{}

func spaceFrom(ctx context.Context) store.Space {
	return ctx.Value(spaceKey{}).(store.Space)
}

// requireSpaceOwner resolves {slug} to a space and requires the caller to own
// it. It guards membership management plus renaming and deleting the space
// and its rooms. A non-member gets 404 rather than 403: whether a space exists is not
// disclosed to anyone outside it, which is the same rule the roster follows.
func (a *app) requireSpaceOwner(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
			return
		}
		orgID, ok := a.resolveOrg(w, r)
		if !ok {
			return
		}
		sp, err := a.spaces.BySlug(r.Context(), orgID, chi.URLParam(r, "slug"))
		if errors.Is(err, store.ErrNoSpace) {
			http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
			return
		}
		role, err := a.spaces.RoleOf(r.Context(), sp.ID, p.UserID)
		if errors.Is(err, store.ErrNotMember) {
			http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
			return
		}
		if role != store.RoleOwner {
			http.Error(w, `{"error":"only a space owner can do that"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), spaceKey{}, sp)))
	})
}
