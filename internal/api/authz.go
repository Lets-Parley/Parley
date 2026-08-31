package api

import (
	"context"
	"errors"
	"log/slog"
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
			if err != nil {
				slog.Error("checking session membership", "session", sess.ID, "error", err)
				http.Error(w, `{"error":"could not load session"}`, http.StatusInternalServerError)
				return
			}
			if !member {
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
		sp, err := a.spaces.BySlug(r.Context(), orgFrom(r.Context()).ID, chi.URLParam(r, "slug"))
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

type orgKey struct{}
type orgRoleKey struct{}

// orgFrom is the org the current request is scoped to. The type assertion is
// deliberately unchecked, exactly like sessionFrom and spaceFrom above: a
// handler mounted outside requireOrgMember must panic loudly rather than read
// a zero uuid and quietly skip the tenancy check. A comma-ok read with a
// zero-value fallback would compile, run, and fail open.
func orgFrom(ctx context.Context) store.Org {
	return ctx.Value(orgKey{}).(store.Org)
}

// orgRoleFrom is the caller's role in orgFrom's org. requireOrgMember puts it
// there in the same lookup that resolved the org, so requireOrgAdmin is a
// context read rather than a third database round trip. The assertion is
// unchecked for the same reason orgFrom's is: this middleware only runs inside
// requireOrgMember.
func orgRoleFrom(ctx context.Context) string {
	return ctx.Value(orgRoleKey{}).(string)
}

// orgSlugFromRoute is the one place in this package that reads the {org} URL
// segment. Everything downstream reads the resolved org from the request
// context instead, so there is exactly one source of truth per request;
// TestOrgParamHasOneReader pins that with go/packages type information, which
// also catches URLParamFromCtx and RouteContext().URLParam.
func orgSlugFromRoute(r *http.Request) string {
	return chi.URLParam(r, "org")
}

// requireOrgMember resolves {org} and requires the caller to belong to it. A
// non-member gets 404 rather than 403, the same posture requireSpaceOwner and
// requireSessionMember take: whether an org exists is not disclosed to anyone
// outside it, so an unprivileged account elsewhere on the instance cannot use
// the status code to enumerate tenants.
//
// It proves only that the *caller* is in this org. It says nothing about which
// org a space resolved by slug belongs to, so every handler behind it must
// still filter its own lookup by the org id this puts in the context.
//
// The caller's role rides along in the context so requireOrgAdmin does not
// re-query. Membership is re-read on every request — there is no cache that
// would outlive a revocation.
func (a *app) requireOrgMember(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
			return
		}
		org, role, err := a.orgs.MembershipBySlug(r.Context(), orgSlugFromRoute(r), p.UserID)
		if errors.Is(err, store.ErrNoOrg) || errors.Is(err, store.ErrNotOrgMember) {
			http.Error(w, `{"error":"no such org"}`, http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, `{"error":"could not load org"}`, http.StatusInternalServerError)
			return
		}
		ctx := context.WithValue(r.Context(), orgKey{}, org)
		ctx = context.WithValue(ctx, orgRoleKey{}, role)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requireOrgAdmin runs inside requireOrgMember and narrows it to the org's
// admins. A member who is not one gets 403 — they are already known to be
// inside the org, so refusing the action discloses nothing the 404 above was
// protecting. The role comes from the context requireOrgMember already filled;
// this gate does not touch the database.
func (a *app) requireOrgAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if orgRoleFrom(r.Context()) != store.OrgRoleAdmin {
			http.Error(w, `{"error":"only an org admin can do that"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireSpaceMember resolves {slug} to a space and requires the caller to
// belong to it. It is the read gate for anything owned by a space rather than
// by the org around it: mounting such a read on org membership instead would
// let any org member enumerate a private space's contents. A non-member gets
// 404, not 403 — a 403 would confirm the space exists.
func (a *app) requireSpaceMember(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
			return
		}
		sp, err := a.spaces.BySlug(r.Context(), orgFrom(r.Context()).ID, chi.URLParam(r, "slug"))
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
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), spaceKey{}, sp)))
	})
}
