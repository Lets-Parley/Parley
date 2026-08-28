package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

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
	Role       string   `json:"role"`
	AvatarIcon string   `json:"avatarIcon"`
	At         *seatRef `json:"at,omitempty"`
}

// seatRef says which live session in this space a member currently has open, so
// the roster can offer "go to where they are". It never names a session outside
// the space, and the roster it rides on is members-only already.
type seatRef struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
}

// sessionView is store.Session plus the presence the space page needs.
// Presence is not a column, so it cannot live on the store struct; embedding
// keeps the wire shape identical and adds one field.
type sessionView struct {
	store.Session
	// Here is how many people have a socket open on this session right now.
	// It is deliberately not filtered through the roster: InSessions matches
	// on session_id and seen_at only and never joins members, whereas the
	// seats below are projected through it. So a member removed a moment ago
	// still counts here until their socket closes — immediately on the
	// replica serving the removal, and within ~30s elsewhere via the
	// membership revalidation tick. A headcount that is briefly one too high
	// is a better trade than a second query on every space load.
	Here int `json:"here"`
}

func (a *app) handleCreateSpace(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	var body struct {
		Name string `json:"name"`
		// Open opts out of the passcode; the default is a protected space.
		Open bool `json:"open"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || utf8.RuneCountInString(name) > 64 {
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

	// Open mode mints anonymous identities, so an org-visible space with no
	// passcode would be a room any visitor could walk into. It gets private
	// spaces; a space is only listed to an org when the org means something.
	visibility := store.VisibilityOrg
	if a.authMode == ModeOpen {
		visibility = store.VisibilityPrivate
	}
	org, ok := a.resolveOrg(w, r)
	if !ok {
		return
	}
	// This route names no org in its path, so requireOrgMember cannot guard
	// it — but the space still lands in one, and every follow-up call against
	// it is org-gated. Creating for an outsider would hand them a space they
	// could not join, open a room in, or set a passcode on. Same 404 as
	// requireOrgMember, and for the same reason: whether an org exists is not
	// disclosed to anyone outside it.
	member, err := a.orgs.IsMember(r.Context(), org.ID, p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load org"}`, http.StatusInternalServerError)
		return
	}
	if !member {
		http.Error(w, `{"error":"no such org"}`, http.StatusNotFound)
		return
	}
	sp, err := a.spaces.Create(r.Context(), org.ID, name, slug, passcode, p.UserID, visibility, a.limits.SpacesPerIdentity)
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
	// orgSlug rides along because a slug alone is no longer an address: the
	// creator is redirected to /o/{org}/s/{slug}, and a client that had to
	// guess the org segment would guess wrong on any instance with two.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": sp.ID, "slug": sp.Slug, "name": sp.Name, "orgSlug": org.Slug,
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
// It is the pre-join link-landing route and stays anonymous, so it cannot sit
// behind requireOrgMember, which needs a principal. It resolves its org from
// the URL segment instead, and does so in the same query as the space: a
// nonexistent org, a space in another org, and a slug that exists nowhere all
// have to fail after the same amount of work — see store.Spaces.BySlugInOrg.
func (a *app) handleGetSpace(w http.ResponseWriter, r *http.Request) {
	sp, err := a.spaces.BySlugInOrg(r.Context(), orgSlugFromRoute(r), chi.URLParam(r, "slug"))
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
			// The count is the same map the seats came from — InSessions
			// stays exactly one query for the whole page. `here` only ever
			// has entries for open sessions, so an ended one reads 0.
			sessionViews := make([]sessionView, len(sessions))
			for i, sess := range sessions {
				sessionViews[i] = sessionView{Session: sess, Here: len(here[sess.ID])}
			}
			views := make([]memberView, len(roster))
			for i, m := range roster {
				views[i] = memberView{UserID: m.UserID, Name: m.Name, AvatarHue: avatarHue(m.UserID), Spectator: m.Spectator, Role: m.Role,
					AvatarIcon: m.AvatarIcon, At: seats[m.UserID]}
			}
			// Members can read the passcode any time — passing it on is the
			// whole point of it.
			writeJSON(w, http.StatusOK, map[string]any{
				"slug": sp.Slug, "name": sp.Name, "members": views, "sessions": sessionViews, "kinds": kinds,
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

// handleMarkSpaceSeen records that a member just opened a space, which is what
// the landing page orders on. Join only ever fires for someone who is not a
// member yet, so without this the list would order by join date.
//
// It is a POST because it writes: rejectCrossSite deliberately waves GETs
// through on the grounds that they change nothing, so the space read must stay
// read-only and the stamp has to arrive on a method the guard actually checks.
// The update matches on the membership row, so it is a silent no-op for anyone
// who is not a member — pinging it can never create or restore a membership.
func (a *app) handleMarkSpaceSeen(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	sp, err := a.spaces.BySlug(r.Context(), orgFrom(r.Context()).ID, chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	if err := a.spaces.MarkSeen(r.Context(), sp.ID, p.UserID); err != nil {
		slog.Warn("could not stamp space visit", "space", sp.ID, "error", err)
		http.Error(w, `{"error":"could not record the visit"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleJoinSpace(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())

	var body struct {
		Passcode string `json:"passcode"`
		// Handle is an invite handle minted by handleMintInviteHandle: what a
		// visitor carries across a provider sign-in instead of the passcode.
		Handle string `json:"handle"`
	}
	// Decode whatever arrives rather than trusting Content-Length: a chunked
	// request declares -1, and skipping the decode would drop a correct
	// passcode and answer 403. An absent body is simply empty.
	if err := decodeOptional(w, r, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
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

	// An existing member never re-presents the code — they already live here.
	member, err := a.spaces.IsMember(r.Context(), sp.ID, p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}
	if sp.Passcode != "" && !member {
		// An invite handle stands in for the passcode, and only for the one
		// space it was minted against. Redemption spends it, so a handle that
		// worked a moment ago will not work again; a handle that is wrong,
		// expired, or for another space simply falls through to the passcode
		// check below and is refused there, on the throttled path.
		admitted := false
		if body.Handle != "" {
			hash, err := store.HashToken(body.Handle)
			if err == nil {
				ok, err := a.spaces.RedeemInviteHandle(r.Context(), sp.ID, hash)
				if err != nil {
					http.Error(w, `{"error":"could not join space"}`, http.StatusInternalServerError)
					return
				}
				admitted = ok
			}
		}
		if !admitted {
			key := clientKey(r) + "|" + sp.ID
			if !a.passcodeAttempts.take(r.Context(), key) {
				http.Error(w, passcodeThrottled, http.StatusTooManyRequests)
				return
			}
			if !passcodeMatches(sp.Passcode, body.Passcode) {
				http.Error(w, passcodeRefused, http.StatusForbidden)
				return
			}
			a.passcodeAttempts.refund(r.Context(), key)
		}
	}

	if err := a.spaces.Join(r.Context(), sp.ID, p.UserID); err != nil {
		http.Error(w, `{"error":"could not join space"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSetPasscode rotates the passcode or opens the space. Any member can do
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

// readName decodes and validates a {"name": …} body against the same 1-64
// character rule space creation uses, so a rename can never produce a name
// that create would have refused.
func readName(w http.ResponseWriter, r *http.Request) (string, bool) {
	var body struct {
		Name string `json:"name"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return "", false
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || utf8.RuneCountInString(name) > 64 {
		http.Error(w, `{"error":"name must be 1-64 characters"}`, http.StatusBadRequest)
		return "", false
	}
	return name, true
}

// handleRenameSpace changes a space's display name. It runs behind
// requireSpaceOwner. The slug does not move with it — see store.Spaces.Rename.
func (a *app) handleRenameSpace(w http.ResponseWriter, r *http.Request) {
	sp := spaceFrom(r.Context())
	name, ok := readName(w, r)
	if !ok {
		return
	}
	if err := a.spaces.Rename(r.Context(), sp.ID, name); err != nil {
		http.Error(w, `{"error":"could not rename this space"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slug": sp.Slug, "name": name})
}

// handleDeleteSpace removes a space and everything in it. Owner-only and
// irreversible.
//
// The rooms are listed before the delete, not after, because afterwards there
// is nothing left to list. Each one is then broadcast: the envelope build
// fails with ErrNoSession on every replica that hears the notification, which
// closes the sockets — see broadcastLocal.
//
// This loop is a latency optimization, not the mechanism. Deleting it does not
// leave anyone stranded: the presence timer reaches the same ErrNoSession
// branch on its next tick, and the membership revalidation tick closes them
// within 30s regardless once the member rows cascade away. It is here so the
// teardown is immediate rather than eventual, which is why removing it does
// not fail TestDeletingClosesTheRoomSockets — that test pins the branch, and
// pinning the loop as well would mean asserting on wall-clock timing.
func (a *app) handleDeleteSpace(w http.ResponseWriter, r *http.Request) {
	sp := spaceFrom(r.Context())

	sessions, err := a.sessions.ListBySpace(r.Context(), sp.ID)
	if err != nil {
		http.Error(w, `{"error":"could not delete this space"}`, http.StatusInternalServerError)
		return
	}
	if err := a.spaces.Delete(r.Context(), sp.ID); errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, `{"error":"could not delete this space"}`, http.StatusInternalServerError)
		return
	}
	for _, sess := range sessions {
		a.broadcastState(r.Context(), sess.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRenameRoom retitles a room. Owner-only, like the rest of this group:
// closing a room is the facilitator's call because it is part of running the
// meeting, but renaming and deleting are housekeeping on the space.
func (a *app) handleRenameRoom(w http.ResponseWriter, r *http.Request) {
	sp := spaceFrom(r.Context())

	var body struct {
		Title string `json:"title"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" || utf8.RuneCountInString(title) > 200 {
		http.Error(w, `{"error":"title must be 1-200 characters"}`, http.StatusBadRequest)
		return
	}

	id := chi.URLParam(r, "id")
	if err := a.sessions.Rename(r.Context(), id, sp.ID, title); errors.Is(err, store.ErrNoSession) {
		http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, `{"error":"could not rename this room"}`, http.StatusInternalServerError)
		return
	}
	// Everyone already in the room gets the new title without a reload.
	a.broadcastState(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "title": title})
}

// handleDeleteRoom removes a room and its history. Owner-only and
// irreversible — a facilitator who wants the room to stop but the numbers to
// survive closes it instead.
func (a *app) handleDeleteRoom(w http.ResponseWriter, r *http.Request) {
	sp := spaceFrom(r.Context())

	id := chi.URLParam(r, "id")
	if err := a.sessions.Delete(r.Context(), id, sp.ID); errors.Is(err, store.ErrNoSession) {
		http.Error(w, `{"error":"no such session"}`, http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, `{"error":"could not delete this room"}`, http.StatusInternalServerError)
		return
	}
	// Closes the sockets on every replica — see handleDeleteSpace.
	a.broadcastState(r.Context(), id)
	w.WriteHeader(http.StatusNoContent)
}

// The two answers the passcode door gives, shared so the mint door gives the
// byte-identical one. A mint that refused differently — its own wording, its
// own status — would be a cheaper oracle than the join it stands in for.
const (
	passcodeRefused   = `{"error":"That passcode doesn't match this space. Passcodes are 6 characters — check for a typo, or ask whoever invited you."}`
	passcodeThrottled = `{"error":"too many tries — wait a minute, then enter the passcode again"}`
)

// handleMintInviteHandle trades a space passcode for an opaque, single-use
// handle on that one space.
//
// It exists for the provider sign-in round trip. An invite link carries its
// passcode in the URL fragment so the code never reaches a server log, but a
// fragment does not survive a navigation to the identity provider and back, so
// something has to wait in the browser meanwhile. This is what waits: a
// capability on one space that expires in minutes and dies on first use,
// rather than the passcode itself, which is the door code for everyone.
//
// Anonymous by necessity — the whole point is that the caller has no identity
// yet — and therefore mounted beside handleGetSpace, outside RequireUser and
// requireOrgMember, resolving its org from the URL segment in the same single
// query. It takes that route's 404 posture with it: a bad org, a space in
// another org and a slug that exists nowhere all answer identically, so this
// cannot become a way to enumerate spaces.
//
// It is a passcode attempt, so it spends from the join door's budget under the
// very same key. Anything less would make it an unauthenticated
// passcode-guessing oracle — a worse door than the one it stands beside.
func (a *app) handleMintInviteHandle(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Passcode string `json:"passcode"`
	}
	if err := decodeOptional(w, r, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}

	sp, err := a.spaces.BySlugInOrg(r.Context(), orgSlugFromRoute(r), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNoSpace) {
		http.Error(w, `{"error":"no such space"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return
	}

	// Exactly the join door's check, in the same order and under the same
	// throttle key, so the two share one budget rather than two.
	if sp.Passcode != "" {
		key := clientKey(r) + "|" + sp.ID
		if !a.passcodeAttempts.take(r.Context(), key) {
			http.Error(w, passcodeThrottled, http.StatusTooManyRequests)
			return
		}
		if !passcodeMatches(sp.Passcode, body.Passcode) {
			http.Error(w, passcodeRefused, http.StatusForbidden)
			return
		}
		a.passcodeAttempts.refund(r.Context(), key)
	}

	plain, hash := store.NewToken()
	if err := a.spaces.CreateInviteHandle(r.Context(), sp.ID, hash, time.Now().Add(store.InviteHandleLifetime)); err != nil {
		http.Error(w, `{"error":"could not prepare the invite"}`, http.StatusInternalServerError)
		return
	}
	// The only time the handle is ever readable: nothing stores it, and no
	// other response carries one.
	writeJSON(w, http.StatusCreated, map[string]any{"handle": plain})
}
