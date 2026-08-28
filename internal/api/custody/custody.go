// Package custody is the org admin's surface over the spaces in their org.
//
// It exists as a package of its own for one reason: custody is management
// without access. An org admin may rename, archive, narrow, delete and repair
// the ownership of any space in the org, including a private one they are not
// in, and must be able to read nothing said inside it — no roster, no
// presence, no votes, no standup entries, no notes.
//
// A comment promising that is worth very little, so the boundary is a build
// constraint instead: nothing here imports the session, presence, poker,
// standup or hub packages, or internal/store, and TestCustodyImportsNothing
// SessionShaped pins that with `go list -deps`. A handler in this package
// cannot reach session content because the types that hold it are not linked
// in. The two constants duplicated from internal/store below are the price of
// that, and they are checked by TestCustodyConstantsMatchTheStore.
package custody

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Duplicated from internal/store rather than imported, so this package links
// nothing that can hold session content. TestCustodyConstantsMatchTheStore
// fails the build if the two ever disagree.
const (
	visibilityPrivate = "private"
	visibilityOrg     = "org"
	roleOwner         = "owner"
	roleMember        = "member"
	orgRoleAdmin      = "admin"
	orgRoleMember     = "member"
	// defaultOrgSlug names the org an instance falls back to. Purging it would
	// leave the instance with nowhere to put a new space, so the purge route
	// refuses it.
	defaultOrgSlug = "default"
)

// maxNameLength matches the spaces.name CHECK constraint, so a custody rename
// can never produce a name that creating the space would have refused.
const maxNameLength = 64

// Scope is what the surrounding router has already established about the
// request: which org it is scoped to, and who is acting. These are the
// trust-bearing values, and handlers here read them from the request context
// only, so the org gate stays the one source of truth. Route params are read —
// a slug and a user id say which space and which member a call is about — but
// only to address a resource inside the org the scope has already fixed:
// nothing in a URL widens what the caller may touch.
type Scope struct {
	OrgID   string
	OrgSlug string
	ActorID string
}

type scopeKey struct{}

// WithScope is how the router hands a request to this package.
func WithScope(ctx context.Context, s Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

// scopeFrom is deliberately an unchecked assertion, matching orgFrom in the
// api package: a custody handler mounted without the admin gate must panic
// loudly rather than read a zero org id and act on every org at once.
func scopeFrom(ctx context.Context) Scope {
	return ctx.Value(scopeKey{}).(Scope)
}

// Handlers is the custody surface. OnMembershipRevoked is optional and is how
// the caller closes the live sockets of somebody who has just been revoked;
// this package holds no reference to the hub.
type Handlers struct {
	Store               *Store
	OnMembershipRevoked func(ctx context.Context, userID string)
}

// Mount registers the custody tree. The caller is responsible for putting the
// org-membership, org-admin and scope middleware in front of it.
func (h *Handlers) Mount(r chi.Router) {
	r.Get("/spaces", h.listSpaces)
	r.Patch("/spaces/{slug}", h.updateSpace)
	r.Delete("/spaces/{slug}", h.deleteSpace)
	r.Post("/spaces/{slug}/owners", h.addOwner)
	r.Post("/spaces/{slug}/claim", h.claimSpace)
	r.Get("/members", h.listMembers)
	r.Post("/members/{userId}/role", h.setMemberRole)
	r.Delete("/members/{userId}", h.revokeMember)
	r.Post("/members/{userId}/restore", h.restoreMember)
}

// CustodySpace is everything custody may say about a space, and the allow-list
// is the type itself. Nothing that could carry what was said in the space has
// a field here to arrive in, so "contains no session content" is enforced by
// the compiler rather than by a reviewer remembering the forbidden names.
//
// OwnerIDs is plural because ownership is: 0015_member_roles.sql places no cap
// on owners and indexes them as a set, and a singular field would have to pick
// one arbitrarily and would misreport every co-owned space.
type CustodySpace struct {
	ID          string     `json:"id"`
	Slug        string     `json:"slug"`
	Name        string     `json:"name"`
	OwnerIDs    []string   `json:"ownerIds"`
	Visibility  string     `json:"visibility"`
	MemberCount int        `json:"memberCount"`
	ArchivedAt  *time.Time `json:"archivedAt"`
}

// OrgMember is one row of the org's membership, as an admin manages it.
type OrgMember struct {
	UserID    string     `json:"userId"`
	Name      string     `json:"name"`
	Role      string     `json:"role"`
	RevokedAt *time.Time `json:"revokedAt"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// decode reads an optional JSON body. An empty body is not an error: several
// custody actions take no arguments at all.
func decode(r *http.Request, v any) error {
	if r.ContentLength == 0 {
		return nil
	}
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<16))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func (h *Handlers) listSpaces(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	spaces, err := h.Store.SpacesInOrg(r.Context(), s.OrgID)
	if err != nil {
		slog.Error("could not list the org's spaces", "org", s.OrgSlug, "error", err)
		http.Error(w, `{"error":"could not list this org's spaces"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, spaces)
}

// updateSpace is rename, archive and narrow, in one PATCH.
//
// Widening is refused here and nowhere else in the tree, and it is the hinge
// of the whole phase: without it, restricting the ownership grant accomplishes
// nothing. An admin flips a private space to org-visible, finds it in the
// directory, and walks in as an ordinary org member with roster, presence,
// votes and standup entries — by a different door, and with every custody
// handler still perfectly pure. Only a space owner widens.
func (h *Handlers) updateSpace(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	var body struct {
		Name       *string `json:"name"`
		Visibility *string `json:"visibility"`
		Archived   *bool   `json:"archived"`
	}
	if err := decode(r, &body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	sp, err := h.Store.SpaceBySlug(r.Context(), s.OrgID, chi.URLParam(r, "slug"))
	if errors.Is(err, ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load that space"}`, http.StatusInternalServerError)
		return
	}

	var change SpaceChange
	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		if name == "" || len([]rune(name)) > maxNameLength {
			http.Error(w, `{"error":"a name must be between 1 and 64 characters"}`, http.StatusBadRequest)
			return
		}
		change.Name = &name
	}
	if body.Visibility != nil {
		switch *body.Visibility {
		case visibilityPrivate:
			change.Visibility = body.Visibility
		case visibilityOrg:
			if sp.Visibility != visibilityOrg {
				http.Error(w, `{"error":"custody can only make a space more private — only a space owner can make it visible to the org"}`, http.StatusForbidden)
				return
			}
		default:
			http.Error(w, `{"error":"visibility must be private or org"}`, http.StatusBadRequest)
			return
		}
	}
	if body.Archived != nil {
		change.Archived = body.Archived
	}

	if err := h.Store.UpdateSpace(r.Context(), s.OrgID, sp.ID, change); err != nil {
		slog.Error("could not update a space under custody", "org", s.OrgSlug, "space", sp.Slug, "error", err)
		http.Error(w, `{"error":"could not update that space"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) deleteSpace(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	sp, err := h.Store.SpaceBySlug(r.Context(), s.OrgID, chi.URLParam(r, "slug"))
	if errors.Is(err, ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load that space"}`, http.StatusInternalServerError)
		return
	}
	if err := h.Store.DeleteSpace(r.Context(), s, sp); err != nil {
		slog.Error("could not delete a space under custody", "org", s.OrgSlug, "space", sp.Slug, "error", err)
		http.Error(w, `{"error":"could not delete that space"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// addOwner grants ownership; it never transfers it. Existing owners keep their
// role, and the target must already be a member of the space.
//
// Both restrictions are load-bearing. A "reassign" that demoted the incumbents
// would hand an org admin one call that removes every owner of a space whose
// contents they cannot see. And without the members-only rule an admin
// appoints themself owner and then walks in through the ordinary member
// routes: the purity of the handlers in this file does not stop the follow-on
// request.
func (h *Handlers) addOwner(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	var body struct {
		UserID string `json:"userId"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.UserID) == "" {
		http.Error(w, `{"error":"a userId is required"}`, http.StatusBadRequest)
		return
	}
	if body.UserID == s.ActorID {
		http.Error(w, `{"error":"an org admin cannot make themself an owner of a space — custody is management, not membership"}`, http.StatusForbidden)
		return
	}
	sp, err := h.Store.SpaceBySlug(r.Context(), s.OrgID, chi.URLParam(r, "slug"))
	if errors.Is(err, ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load that space"}`, http.StatusInternalServerError)
		return
	}
	err = h.Store.AddOwner(r.Context(), s, sp, body.UserID)
	switch {
	case errors.Is(err, ErrNotAMember):
		http.Error(w, `{"error":"custody can only promote somebody who is already a member of this space"}`, http.StatusForbidden)
	case err != nil:
		slog.Error("could not grant space ownership", "org", s.OrgSlug, "space", sp.Slug, "error", err)
		http.Error(w, `{"error":"could not grant ownership of that space"}`, http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// claimSpace is the one action that makes an org admin a member of a space
// they were not in, and it exists only because there is nobody left to hand it
// to. It is refused while any member remains, and it is audit-logged: the
// record is the control that makes the escalation acceptable, and it survives
// the space and the org being deleted.
func (h *Handlers) claimSpace(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	sp, err := h.Store.SpaceBySlug(r.Context(), s.OrgID, chi.URLParam(r, "slug"))
	if errors.Is(err, ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load that space"}`, http.StatusInternalServerError)
		return
	}
	err = h.Store.ClaimSpace(r.Context(), s, sp)
	switch {
	case errors.Is(err, ErrNotAbandoned):
		http.Error(w, `{"error":"this space still has members — claiming is only for a space nobody is left in"}`, http.StatusConflict)
	case err != nil:
		slog.Error("could not claim an abandoned space", "org", s.OrgSlug, "space", sp.Slug, "error", err)
		http.Error(w, `{"error":"could not claim that space"}`, http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *Handlers) listMembers(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	members, err := h.Store.OrgMembers(r.Context(), s.OrgID)
	if err != nil {
		slog.Error("could not list org members", "org", s.OrgSlug, "error", err)
		http.Error(w, `{"error":"could not list this org's members"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, members)
}

func (h *Handlers) setMemberRole(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	var body struct {
		Role string `json:"role"`
	}
	if err := decode(r, &body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	if body.Role != orgRoleAdmin && body.Role != orgRoleMember {
		http.Error(w, `{"error":"role must be admin or member"}`, http.StatusBadRequest)
		return
	}
	err := h.Store.SetOrgRole(r.Context(), s.OrgID, chi.URLParam(r, "userId"), body.Role)
	switch {
	case errors.Is(err, ErrNotAMember):
		http.Error(w, `{"error":"that person is not a member of this org"}`, http.StatusNotFound)
	case errors.Is(err, ErrLastAdmin):
		http.Error(w, `{"error":"this org would be left with no admin — promote somebody else first"}`, http.StatusConflict)
	case err != nil:
		slog.Error("could not set an org role", "org", s.OrgSlug, "error", err)
		http.Error(w, `{"error":"could not change that role"}`, http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// revokeMember removes somebody from the org and from every space in it.
//
// The per-space half is the delicate one. mutateMembership in internal/store
// enforces "not the last owner" one space at a time, and a cross-org bulk
// delete bypasses it entirely — 0015 says outright that an ownerless space can
// never be managed by anyone again. So the revoke promotes a replacement where
// it can and refuses, naming the spaces, where it cannot.
func (h *Handlers) revokeMember(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	userID := chi.URLParam(r, "userId")
	blocked, err := h.Store.RevokeOrgMember(r.Context(), s, userID)
	switch {
	case errors.Is(err, ErrLastAdmin):
		http.Error(w, `{"error":"this org would be left with no admin — promote somebody else first"}`, http.StatusConflict)
	case errors.Is(err, ErrWouldStrandSpace):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":  "these spaces would be left with no owner — promote somebody else in them first",
			"spaces": blocked,
		})
	case err != nil:
		slog.Error("could not revoke an org member", "org", s.OrgSlug, "error", err)
		http.Error(w, `{"error":"could not revoke that member"}`, http.StatusInternalServerError)
	default:
		if h.OnMembershipRevoked != nil {
			h.OnMembershipRevoked(r.Context(), userID)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// restoreMember lifts a revocation. Without it a mis-click is permanent for
// that person in that org: the tombstone is deliberately not cleared by a
// sign-in, so nothing else would ever remove it.
func (h *Handlers) restoreMember(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	err := h.Store.RestoreOrgMember(r.Context(), s.OrgID, chi.URLParam(r, "userId"))
	switch {
	case errors.Is(err, ErrNotAMember):
		http.Error(w, `{"error":"there is no revoked membership to restore"}`, http.StatusNotFound)
	case err != nil:
		slog.Error("could not restore an org member", "org", s.OrgSlug, "error", err)
		http.Error(w, `{"error":"could not restore that member"}`, http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// PurgeOrg destroys an org and everything in it. It is mounted at
// DELETE /api/orgs/{org} by the router rather than inside the custody tree,
// because it is not an action on a space.
//
// It is irreversible, so it asks for the org's own slug back before it will
// run, and it says exactly what it is about to destroy when the confirmation
// does not match. The counts are read inside the same transaction that does
// the deleting: read outside it, they would be a number from a moment that no
// longer exists by the time anything is destroyed.
func (h *Handlers) PurgeOrg(w http.ResponseWriter, r *http.Request) {
	s := scopeFrom(r.Context())
	if s.OrgSlug == defaultOrgSlug {
		http.Error(w, `{"error":"the default org cannot be purged — it is where an instance puts everything that names no org"}`, http.StatusForbidden)
		return
	}
	var body struct {
		Confirm string `json:"confirm"`
	}
	if err := decode(r, &body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	counts, err := h.Store.Purge(r.Context(), s, body.Confirm)
	switch {
	case errors.Is(err, ErrConfirmationRequired):
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":    "purging an org is permanent — send the org's slug as \"confirm\" to go ahead",
			"org":      s.OrgSlug,
			"spaces":   counts.Spaces,
			"sessions": counts.Sessions,
		})
	case err != nil:
		slog.Error("could not purge an org", "org", s.OrgSlug, "error", err)
		http.Error(w, `{"error":"could not purge this org"}`, http.StatusInternalServerError)
	default:
		writeJSON(w, http.StatusOK, map[string]any{
			"org": s.OrgSlug, "spaces": counts.Spaces, "sessions": counts.Sessions,
		})
	}
}
