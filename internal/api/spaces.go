package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/store"
)

type memberView struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarHue int    `json:"avatarHue"`
	Spectator bool   `json:"spectator"`
	// Role says who can manage the room. Every member sees it — it is what
	// tells them who to ask.
	Role string   `json:"role"`
	At   *seatRef `json:"at,omitempty"`
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
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
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

	sp, err := a.spaces.Create(r.Context(), name, slug, passcode, p.UserID, a.limits.SpacesPerIdentity)
	if errors.Is(err, store.ErrSlugTaken) {
		http.Error(w, `{"error":"that space name is taken — pick another"}`, http.StatusConflict)
		return
	}
	if errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, `{"error":"space limit reached for this identity"}`, http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not create space"}`, http.StatusInternalServerError)
		return
	}
	// The creator is the one person who has to see the code straight away.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": sp.ID, "slug": sp.Slug, "name": sp.Name,
		"passcode": sp.Passcode, "protected": sp.Passcode != "",
	})
}

// handleListMySpaces lists the spaces the caller belongs to, most recently
// active first, so a signed-in visitor lands on their own tables.
func (a *app) handleListMySpaces(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	spaces, err := a.spaces.ForUser(r.Context(), p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load your spaces"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, spaces)
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
			// Opening a space you already belong to is what "active" means;
			// join only ever fires for someone who is not a member yet, so
			// without this the landing list would order by join date.
			// Best effort: a failed stamp is a slightly stale sort order, not
			// a reason to refuse the page.
			if err := a.spaces.MarkSeen(r.Context(), sp.ID, p.UserID); err != nil {
				slog.Warn("could not stamp space visit", "space", sp.ID, "error", err)
			}
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
			// A member is "at" a session only while a socket is actually
			// open — on any replica, not just this one.
			open := make([]string, 0, len(sessions))
			for _, sess := range sessions {
				if sess.EndedAt == nil {
					open = append(open, sess.ID)
				}
			}
			// One query for the whole space. Asking per session turned a page
			// load into a round trip per open session.
			here, err := a.presence.InSessions(r.Context(), open)
			if err != nil {
				http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
				return
			}
			seats := map[string]*seatRef{}
			for _, sess := range sessions {
				if sess.EndedAt != nil {
					continue
				}
				for _, uid := range here[sess.ID] {
					if _, taken := seats[uid]; !taken {
						seats[uid] = &seatRef{SessionID: sess.ID, Title: sess.Title}
					}
				}
			}
			// The create dialog offers exactly these: a kind retired in place
			// keeps its row for the sessions that already use it, but must
			// not be offered for a new one.
			kinds, err := a.sessions.OfferableKinds(r.Context())
			if err != nil {
				http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
				return
			}
			views := make([]memberView, len(roster))
			for i, m := range roster {
				views[i] = memberView{UserID: m.UserID, Name: m.Name, AvatarHue: avatarHue(m.UserID), Spectator: m.Spectator, Role: m.Role, At: seats[m.UserID]}
			}
			// Members can read the room code any time — passing it on is the
			// whole point of it.
			writeJSON(w, http.StatusOK, map[string]any{
				"slug": sp.Slug, "name": sp.Name, "members": views, "sessions": sessions, "kinds": kinds,
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
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
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
		key := clientKey(r) + "|" + sp.ID
		if !a.passcodeAttempts.take(r.Context(), key) {
			http.Error(w, `{"error":"too many tries — wait a minute, then enter the passcode again"}`, http.StatusTooManyRequests)
			return
		}
		if !passcodeMatches(sp.Passcode, body.Passcode) {
			http.Error(w, `{"error":"That passcode doesn't match this space. Passcodes are 6 characters — check for a typo, or ask whoever invited you."}`, http.StatusForbidden)
			return
		}
		a.passcodeAttempts.refund(r.Context(), key)
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
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
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

// handleSetMemberRole promotes or demotes a member. It runs behind
// requireSpaceOwner, so the caller is already known to own this space.
func (a *app) handleSetMemberRole(w http.ResponseWriter, r *http.Request) {
	sp := spaceFrom(r.Context())

	var body struct {
		Role string `json:"role"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"role is required"}`)
		return
	}

	err := a.spaces.SetRole(r.Context(), sp.ID, chi.URLParam(r, "userId"), body.Role)
	switch {
	case errors.Is(err, store.ErrBadRole):
		http.Error(w, `{"error":"role must be owner or member"}`, http.StatusBadRequest)
	case errors.Is(err, store.ErrNotMember):
		http.Error(w, `{"error":"that person is not a member of this space"}`, http.StatusNotFound)
	case errors.Is(err, store.ErrLastOwner):
		http.Error(w, `{"error":"this space would be left with no owner — promote someone else first, then step down"}`, http.StatusConflict)
	case err != nil:
		http.Error(w, `{"error":"could not change that member's role"}`, http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleRemoveMember revokes membership. Membership is checked against the
// database on every request, so the next thing the removed member does puts
// them back in front of the passcode gate — there is no cache to expire. A
// WebSocket that is already open is not a request, though, so the removal
// also closes their sockets: on this process immediately, on any other one at
// the next revalidation tick.
func (a *app) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	sp := spaceFrom(r.Context())

	userID := chi.URLParam(r, "userId")
	err := a.spaces.RemoveMember(r.Context(), sp.ID, userID)
	if err == nil {
		a.hub.DisconnectSpaceMember(sp.ID, userID)
	}
	switch {
	case errors.Is(err, store.ErrNotMember):
		http.Error(w, `{"error":"that person is not a member of this space"}`, http.StatusNotFound)
	case errors.Is(err, store.ErrLastOwner):
		http.Error(w, `{"error":"this space would be left with no owner — promote someone else first"}`, http.StatusConflict)
	case err != nil:
		http.Error(w, `{"error":"could not remove that member"}`, http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
