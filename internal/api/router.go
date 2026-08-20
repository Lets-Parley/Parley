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
}

type Options struct {
	SecureCookies bool
	AllowedOrigin string
	// AuthMode is ModeOpen (the default) or ModeOIDC.
	AuthMode string
	// OIDC must be set when AuthMode is ModeOIDC and is ignored otherwise.
	OIDC *auth.Provider
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
	SpacesPerIdentity    int
	SessionsPerSpace     int
	StoriesPerSession    int
}

func (l Limits) withDefaults() Limits {
	if l.IdentityIPHourly == 0 {
		l.IdentityIPHourly = 10
	}
	if l.IdentityGlobalHourly == 0 {
		l.IdentityGlobalHourly = 500
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
		spaces:   &store.Spaces{Pool: pool},
		sessions: &store.Sessions{Pool: pool},
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
	a.hub.ValidateMembership = func(ctx context.Context, spaceID, userID string) (bool, error) {
		return a.spaces.IsMember(ctx, spaceID, userID)
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
		r.Post("/me", a.handlePostMe)
		r.Get("/me", a.handleGetMe)
		r.Delete("/me", a.handleDeleteMe)

		r.Get("/spaces/{slug}", a.handleGetSpace)
		r.Group(func(r chi.Router) {
			r.Use(RequireUser)
			r.Get("/spaces", a.handleListMySpaces)
			r.Post("/spaces", a.handleCreateSpace)
			r.Post("/spaces/{slug}/join", a.handleJoinSpace)
			r.Post("/spaces/{slug}/passcode", a.handleSetPasscode)
			r.Post("/spaces/{slug}/sessions", a.handleCreateSession)
		})

		// Membership management is owner-only, and the middleware answers 404
		// to anyone outside the space rather than admitting it exists.
		r.Route("/spaces/{slug}/members/{userId}", func(r chi.Router) {
			r.Use(a.requireSpaceOwner)
			r.Post("/role", a.handleSetMemberRole)
			r.Delete("/", a.handleRemoveMember)
		})

		// requireSessionMember answers 404 for anonymous callers too, so these
		// routes sit outside RequireUser: a session's existence is never
		// disclosed to anyone outside its space.
		r.Route("/sessions/{id}", func(r chi.Router) {
			r.Use(a.requireSessionMember)
			r.Get("/", a.handleGetSession)
			r.Get("/export.csv", a.handleExportCSV)
			// The one action dispatcher, mounted for every method so the
			// dispatcher itself decides 404-vs-405. Kind actions are resolved
			// against this session's own kind, so two kinds can name an action
			// the same thing without sharing a namespace to collide in.
			r.HandleFunc("/actions/{action}", a.handleAction)
			r.With(rejectEnded).Post("/facilitator/claim", a.handleClaimFacilitator)
			r.With(rejectEnded).Post("/spectator", a.handleSetSpectator)
			r.Group(func(r chi.Router) {
				r.Use(rejectEnded)
				r.Use(requireFacilitator)
				r.Post("/facilitator", a.handleTransferFacilitator)
			})
			// Close and reopen sit outside the rejectEnded group. Reopen is
			// the one write that only makes sense on an ended session, and
			// close stays idempotent — a second DELETE is a no-op 204, which
			// the handler enforces itself.
			r.Group(func(r chi.Router) {
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
