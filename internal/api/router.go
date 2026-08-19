package api

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/auth"
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
	// TrustProxyHeaders reads the client address from X-Forwarded-For and
	// friends. Turn it on only when a proxy in front overwrites those headers;
	// exposed directly, it hands every caller a free choice of address.
	TrustProxyHeaders bool
	// Context bounds the cross-replica notification listener. Leave it nil
	// outside of tests: the listener then lives as long as the process.
	Context context.Context
}

func Router(pool *pgxpool.Pool, opts Options) http.Handler {
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
		pool:          pool,
		users:         &store.Users{Pool: pool},
		spaces:        &store.Spaces{Pool: pool},
		sessions:      &store.Sessions{Pool: pool},
		hub:           hub.New(),
		kinds:         kinds,
		secureCookies: opts.SecureCookies,
		allowedOrigin: opts.AllowedOrigin,
		authMode:      mode,
		version:       cmp.Or(opts.Version, "dev"),

		passcodeAttempts: newAttemptLimiter(),
		instanceID:       newInstanceID(),
	}
	if mode == ModeOIDC {
		a.oidc = opts.OIDC
	}
	listenCtx := opts.Context
	if listenCtx == nil {
		listenCtx = context.Background()
	}
	go a.listen(listenCtx)

	a.hub.OnPresenceChange = func(sessionID string) {
		a.broadcastState(context.Background(), sessionID)
	}
	a.hub.OnFacilitatorSeen = func(sessionID, userID string) {
		a.sessions.TouchFacilitatorSeen(context.Background(), sessionID, userID)
	}

	r := chi.NewRouter()
	// RealIP rewrites RemoteAddr from X-Forwarded-For, which the caller writes.
	// That is correct behind a proxy that overwrites the header, and a hole
	// anywhere else: the room-code throttle is keyed on the client address, so
	// trusting a header the guesser controls would let a script reset its own
	// limit on every request. Off unless the operator says otherwise.
	if opts.TrustProxyHeaders {
		r.Use(middleware.RealIP)
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
		r.Use(resolvePrincipal(a.users, mode == ModeOIDC))

		r.Get("/auth", a.handleAuthConfig)
		r.Post("/me", a.handlePostMe)
		r.Get("/me", a.handleGetMe)
		r.Delete("/me", a.handleDeleteMe)

		r.Get("/spaces/{slug}", a.handleGetSpace)
		r.Group(func(r chi.Router) {
			r.Use(RequireUser)
			r.Post("/spaces", a.handleCreateSpace)
			r.Post("/spaces/{slug}/join", a.handleJoinSpace)
			r.Post("/spaces/{slug}/passcode", a.handleSetPasscode)
			r.Post("/spaces/{slug}/sessions", a.handleCreateSession)
		})

		// Deprecated, one release only: the story-scoped poker routes carry
		// the story in the path instead of the body, so they cannot go
		// through the dispatcher and keep their own copy of the ladder.
		poker.New(a.pool, a.hub, a.broadcastState).MountLegacyStories(r)

		// requireSessionMember answers 404 for anonymous callers too, so these
		// routes sit outside RequireUser: a session's existence is never
		// disclosed to anyone outside its space.
		r.Route("/sessions/{id}", func(r chi.Router) {
			r.Use(a.requireSessionMember)
			r.Get("/", a.handleGetSession)
			r.Get("/export.csv", a.handleExportCSV)
			// The one action dispatcher. Kind actions are resolved against
			// this session's own kind, so two kinds can name an action the
			// same thing without sharing a namespace to collide in.
			r.Post("/actions/{action}", a.handleAction)
			for _, al := range legacyAliases {
				r.MethodFunc(al.method, al.path, a.aliasAction(al.action))
			}
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

	return r
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
