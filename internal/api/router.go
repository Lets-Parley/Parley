package api

import (
	"bytes"
	"cmp"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/auth"
	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/poker"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/standup"
	"github.com/lets-parley/parley/internal/store"
	"github.com/lets-parley/parley/web"
)

type app struct {
	pool     *pgxpool.Pool
	users    *store.Users
	spaces   *store.Spaces
	sessions *store.Sessions
	links    *store.Links
	presence *store.Presence
	hub      *hub.Hub
	// kinds is the session-kind registry, built once at wiring time.
	kinds *session.Registry

	secureCookies bool
	allowedOrigin string
	// authMode is ModeOpen or ModeOIDC; oidc is non-nil only in the latter.
	authMode string
	version  string
	oidc     *auth.Provider
	// passcodeAttempts throttles room-code guessing at the join door.
	passcodeAttempts *attemptLimiter
	limits           Limits
	// instanceID names this replica so it can ignore the echo of its own
	// notifications; listenerUp is what /readyz reads to decide whether this
	// replica can still hear the others.
	instanceID string
	listenerUp atomic.Bool
	// orgs resolves the org a slug belongs to. Until an instance is divided,
	// that is always the default org, cached behind defaultOrg.
	orgs *store.Orgs
	// bootstrapAdmin is the (issuer, subject) pair an operator granted admin
	// of the default org from configuration.
	bootstrapAdmin BootstrapAdmin
	orgMu          sync.Mutex
	defaultOrg     string
}

type Options struct {
	SecureCookies bool
	AllowedOrigin string
	// AuthMode is ModeOpen (the default) or ModeOIDC.
	AuthMode string
	// OIDC must be set when AuthMode is ModeOIDC and is ignored otherwise.
	OIDC *auth.Provider
	// BootstrapAdmin, when set, is granted admin of the default org the first
	// time that identity signs in. Ignored outside ModeOIDC.
	BootstrapAdmin BootstrapAdmin
	// Version is the build's version string; "dev" when left unset.
	Version string
	// TrustProxyHeaders reads X-Forwarded-For only from hops in
	// TrustedProxyCIDRs. Other forwarding headers are always ignored.
	TrustProxyHeaders bool
	TrustedProxyCIDRs []netip.Prefix
	Limits            Limits

	// Context bounds the cross-replica notification listener. Leave it nil
	// outside of tests: the listener then lives as long as the process.
	Context context.Context

	sessionRevalidationInterval time.Duration
}

type Limits struct {
	IdentityIPHourly     int
	IdentityGlobalHourly int
	// LinkRedemptionIPHourly is redemption's own per-address budget. It has to
	// be at least store.LinkRedemptionCap, or a team on one egress address
	// cannot reach the cap the link advertises.
	LinkRedemptionIPHourly int
	SpacesPerIdentity      int
	SessionsPerSpace       int
	StoriesPerSession      int
	LinksPerSession        int
}

func (l Limits) withDefaults() Limits {
	if l.IdentityIPHourly == 0 {
		l.IdentityIPHourly = 10
	}
	if l.IdentityGlobalHourly == 0 {
		l.IdentityGlobalHourly = 500
	}
	if l.LinkRedemptionIPHourly == 0 {
		l.LinkRedemptionIPHourly = 50
	}
	if l.SpacesPerIdentity == 0 {
		l.SpacesPerIdentity = 50
	}
	if l.SessionsPerSpace == 0 {
		l.SessionsPerSpace = 500
	}
	if l.StoriesPerSession == 0 {
		l.StoriesPerSession = 500
	}
	if l.LinksPerSession == 0 {
		l.LinksPerSession = 20
	}
	return l
}

// Handler owns both the HTTP router and the lifecycle of its WebSocket hub.
type Handler struct {
	http.Handler
	hub *hub.Hub
}

func (h *Handler) Shutdown() {
	h.hub.Shutdown()
}

func Router(pool *pgxpool.Pool, opts Options) *Handler {
	// A duplicate kind is a wiring mistake in this very function, so it can
	// only be a programming error — fail the process rather than serve a
	// registry that is missing a kind.
	kinds := session.NewRegistry()
	for _, k := range []session.Kind{poker.Kind(), standup.Kind()} {
		if err := kinds.Register(k); err != nil {
			panic(fmt.Sprintf("wiring session kinds: %v", err))
		}
	}
	mode := opts.AuthMode
	if mode == "" {
		mode = ModeOpen
	}
	a := &app{
		pool:     pool,
		users:    &store.Users{Pool: pool},
		orgs:     &store.Orgs{Pool: pool},
		spaces:   &store.Spaces{Pool: pool},
		sessions: &store.Sessions{Pool: pool},
		links:    &store.Links{Pool: pool},
		presence: &store.Presence{
			Pool:      pool,
			ReplicaID: replicaID(),
			// Twice the pong deadline. A client is pinged every 25s and has 50s
			// to answer, so anything shorter would drop people who are merely
			// slow to reply — the opposite of what presence is for.
			Window: 2 * hub.PongDeadline,
		},
		hub:           hub.New(),
		kinds:         kinds,
		secureCookies: opts.SecureCookies,
		allowedOrigin: opts.AllowedOrigin,
		authMode:      mode,
		version:       cmp.Or(opts.Version, "dev"),

		passcodeAttempts: newAttemptLimiter(pool),
		limits:           opts.Limits.withDefaults(),
		instanceID:       newInstanceID(),
	}
	if mode == ModeOIDC {
		a.oidc = opts.OIDC
		a.bootstrapAdmin = opts.BootstrapAdmin
	}
	listenCtx := opts.Context
	if listenCtx == nil {
		listenCtx = context.Background()
	}
	// Router tolerates a nil pool — /version answers without a database, and
	// tests use that. Nothing below here may assume otherwise.
	if pool != nil {
		go a.listen(listenCtx)
		go a.sweepPresence(listenCtx)
	}

	a.hub.OnPresenceChange = func(sessionID string) {
		a.broadcastState(context.Background(), sessionID)
	}
	a.hub.OnFacilitatorSeen = func(sessionID, userID string) {
		ctx := context.Background()
		a.sessions.TouchFacilitatorSeen(ctx, sessionID, userID)
		// Fires on connect and on every pong, which is exactly the heartbeat
		// presence needs — no second timer required.
		if err := a.presence.Seen(ctx, sessionID, userID); err != nil {
			slog.Error("could not record presence", "session", sessionID, "user", userID, "error", err)
		}
	}
	a.hub.RevalidationInterval = opts.sessionRevalidationInterval
	a.hub.ValidateSession = func(ctx context.Context, tokenID string) (time.Time, error) {
		return a.users.TokenExpiry(ctx, []byte(tokenID))
	}
	// Link-aware, and it needs the room to be: a link guest is deliberately not
	// a member of the room's space, so a check that only knew the space would
	// evict them on the revalidation tick.
	a.hub.ValidateMembership = func(ctx context.Context, sessionID, spaceID, userID string) (bool, error) {
		return a.spaces.IsMemberOrLinkGuest(ctx, spaceID, sessionID, userID)
	}
	a.hub.OnDisconnect = func(sessionID, userID string) {
		if err := a.presence.Gone(context.Background(), sessionID, userID); err != nil {
			slog.Error("could not clear presence", "session", sessionID, "user", userID, "error", err)
		}
	}

	r := chi.NewRouter()
	// Forwarded addresses affect both open-mode identity creation and room-code
	// throttles, so they are accepted only across an explicitly trusted chain.
	if opts.TrustProxyHeaders {
		r.Use(trustedProxyHeaders(opts.TrustedProxyCIDRs, slog.Default()))
	}
	r.Use(middleware.Recoverer)
	r.Use(securityHeaders)

	// Liveness must never touch the database: a DB blip restarting the process
	// would drop every WebSocket in the room.
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Same reasoning, plus one more: "am I running the patched build?" has to be
	// answerable before Postgres is up, so this touches neither the database
	// nor the session.
	r.Get("/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"version": a.version})
	})

	r.Get("/readyz", func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte("database unreachable"))
			return
		}
		// A replica that cannot hear the others still answers requests and
		// still holds its WebSockets — it just never learns that anyone else
		// changed anything. Ready has to mean "in the room", not "process
		// alive", or a dead listener stays invisible behind a green probe.
		if !a.listenerHealthy() {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte("not listening for session changes"))
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Sign-in lives outside /api: these are browser navigations that arrive
	// from the identity provider's domain, so the JSON-body and cross-site
	// guards that protect the API would reject them by design. Their own CSRF
	// protection is the state value carried in the sign-in cookie.
	r.Route("/auth", func(r chi.Router) {
		r.Get("/login", a.handleAuthLogin)
		r.Get("/callback", a.handleAuthCallback)
	})

	r.Route("/api", func(r chi.Router) {
		r.Use(rejectCrossSite(a.allowedOrigin))
		r.Use(requireJSONBody)
		r.Use(limitAPIRequestBody)
		r.Use(resolvePrincipal(a.users, mode == ModeOIDC))

		r.Get("/auth", a.handleAuthConfig)
		// Redeeming is the one door a link guest walks through, so it is the
		// one /api route that neither requires an identity nor rejects a link
		// one. Everything it mints is scoped to a single room.
		r.Post("/links/redeem", a.handleRedeemLink)

		// The identity routes sit outside RequireUser — they are where an
		// identity comes from — so link guests are turned away here
		// explicitly. Renaming in particular: a link guest wearing the
		// facilitator's name on the roster is the cheapest impersonation in
		// the product.
		r.With(rejectLinkPrincipal).Post("/me", a.handlePostMe)
		// Open to a link guest: the only identity route that is. It hands
		// back what the guest already has — its own name, avatar and bound
		// room — so a browser with no local storage can recover instead of
		// being stranded in the name gate. Writing identity stays shut.
		r.Get("/me", a.handleGetMe)
		// Open to a link guest too, and the only write on its identity that
		// is: it spends the credential rather than reshaping it. A guest on a
		// borrowed browser otherwise has no way to stop the cookie outliving
		// the visit. It deletes the caller's own session_tokens row and
		// nothing else — votes, standup entries and CSV attribution survive
		// leaving exactly as they survive revocation.
		r.Delete("/me", a.handleDeleteMe)
		// Its own route, and permitted under both auth modes: choosing an
		// avatar is not choosing a name, so the provider owning names in OIDC
		// mode does not reach it. It answers 401 itself.
		r.With(rejectLinkPrincipal).Patch("/me/avatar", a.handlePatchMeAvatar)

		// Open to anonymous callers, and so also outside RequireUser: a link
		// guest is bound to one room and is told nothing about the space
		// around it.
		r.With(rejectLinkPrincipal).Get("/spaces/{slug}", a.handleGetSpace)
		r.Group(func(r chi.Router) {
			r.Use(RequireUser)
			r.Get("/spaces", a.handleListMySpaces)
			r.Post("/spaces", a.handleCreateSpace)
			r.Post("/spaces/{slug}/join", a.handleJoinSpace)
			r.Post("/spaces/{slug}/seen", a.handleMarkSpaceSeen)
			r.Post("/spaces/{slug}/passcode", a.handleSetPasscode)
			r.Post("/spaces/{slug}/sessions", a.handleCreateSession)
		})

		// Managing the space itself is owner-only, and the middleware answers
		// 404 to anyone outside the space rather than admitting it exists.
		// These hang off the /api router by method rather than a Route group,
		// because GET /spaces/{slug} is already mounted at this pattern and is
		// deliberately open to non-members.
		r.With(a.requireSpaceOwner).Patch("/spaces/{slug}", a.handleRenameSpace)
		r.With(a.requireSpaceOwner).Delete("/spaces/{slug}", a.handleDeleteSpace)

		r.Route("/spaces/{slug}/members/{userId}", func(r chi.Router) {
			r.Use(a.requireSpaceOwner)
			r.Post("/role", a.handleSetMemberRole)
			r.Delete("/", a.handleRemoveMember)
		})

		// Renaming and deleting a room are housekeeping on the space, so they
		// are owner-only and live here rather than under /sessions/{id}, where
		// the facilitator-scoped meeting controls are. Closing a room stays
		// the facilitator's: it ends a meeting, it does not discard one.
		r.Route("/spaces/{slug}/sessions/{id}", func(r chi.Router) {
			r.Use(a.requireSpaceOwner)
			r.Patch("/", a.handleRenameRoom)
			r.Delete("/", a.handleDeleteRoom)
		})

		// requireSessionMember answers 404 for anonymous callers too, so these
		// routes sit outside RequireUser: a session's existence is never
		// disclosed to anyone outside its space.
		r.Route("/sessions/{id}", func(r chi.Router) {
			r.Use(a.requireSessionMember)
			r.Get("/", a.handleGetSession)
			// The export is the room's whole history in one file, including
			// every meeting it has held. Membership is not enough for it once
			// a link guest can be a caller here.
			r.With(rejectLinkPrincipal).Get("/export.csv", a.handleExportCSV)
			// The one action dispatcher, mounted for every method so the
			// dispatcher itself decides 404-vs-405. Kind actions are resolved
			// against this session's own kind, so two kinds can name an action
			// the same thing without sharing a namespace to collide in.
			r.HandleFunc("/actions/{action}", a.handleAction)
			// Claiming has no facilitator gate by design — it exists for when
			// there is no live facilitator to ask — so it is the one place a
			// link guest could seize the room. Refused here, and again in the
			// UPDATE that store.ClaimFacilitator runs.
			r.With(rejectEnded, rejectLinkPrincipal).Post("/facilitator/claim", a.handleClaimFacilitator)
			// Spectating is a flag on a space member, and a link guest is not
			// one — the toggle has no row to write. Refused rather than
			// silently accepted, so nobody builds on an answer that lied.
			r.With(rejectEnded, rejectLinkPrincipal).Post("/spectator", a.handleSetSpectator)
			// Signed links. Any member may see how many links a room has and
			// how often they have been used; only the facilitator may mint or
			// revoke one, and only while the room is still open.
			// A link guest never sees the links to its own room, minted or
			// otherwise: how many exist and how often they have been used is
			// the room's business, not its guests'.
			r.With(rejectLinkPrincipal).Get("/links", a.handleListSessionLinks)
			r.With(rejectEnded, rejectLinkPrincipal, requireFacilitator).Post("/links", a.handleCreateSessionLink)
			r.With(rejectLinkPrincipal, requireFacilitator).Delete("/links/{linkId}", a.handleRevokeSessionLink)
			r.Group(func(r chi.Router) {
				r.Use(rejectEnded)
				r.Use(rejectLinkPrincipal)
				r.Use(requireFacilitator)
				r.Post("/facilitator", a.handleTransferFacilitator)
			})
			// Close and reopen sit outside the rejectEnded group. Reopen is
			// the one write that only makes sense on an ended session, and
			// close stays idempotent — a second DELETE is a no-op 204, which
			// the handler enforces itself.
			r.Group(func(r chi.Router) {
				r.Use(rejectLinkPrincipal)
				r.Use(requireFacilitator)
				r.Delete("/", a.handleCloseSession)
				r.Post("/reopen", a.handleReopenSession)
			})
		})
	})

	r.With(resolvePrincipal(a.users, mode == ModeOIDC)).Get("/ws", a.handleWS)

	r.NotFound(web.SPAHandler())

	return &Handler{Handler: r, hub: a.hub}
}

func limitAPIRequestBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bounded := http.MaxBytesReader(w, r.Body, httprequest.MaxJSONBody)
		body, err := io.ReadAll(bounded)
		bounded.Close()
		if err != nil {
			httprequest.WriteDecodeError(w, err, `{"error":"could not read request body"}`)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, r)
	})
}

// requireJSONBody rejects non-GET requests whose body is not declared JSON,
// which blocks cross-site form posts.
func requireJSONBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.ContentLength != 0 {
			ct := r.Header.Get("Content-Type")
			if !strings.HasPrefix(ct, "application/json") {
				http.Error(w, `{"error":"Content-Type must be application/json"}`, http.StatusUnsupportedMediaType)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// resolveOrg hands a handler the org it resolves slugs within, or answers the
// request itself and reports false.
func (a *app) resolveOrg(w http.ResponseWriter, r *http.Request) (string, bool) {
	orgID, err := a.orgID(r.Context())
	if err != nil {
		http.Error(w, `{"error":"could not load space"}`, http.StatusInternalServerError)
		return "", false
	}
	return orgID, true
}

// orgID is the org a slug is resolved within: until an instance is divided,
// the default org. It is read once and cached rather than resolved at wiring
// time, because a pool is lazy — Router must not require a reachable database
// to hand back a handler.
func (a *app) orgID(ctx context.Context) (string, error) {
	a.orgMu.Lock()
	defer a.orgMu.Unlock()
	if a.defaultOrg != "" {
		return a.defaultOrg, nil
	}
	org, err := a.orgs.Default(ctx)
	if err != nil {
		return "", err
	}
	a.defaultOrg = org.ID
	return org.ID, nil
}
