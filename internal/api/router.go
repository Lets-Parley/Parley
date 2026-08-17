package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/auth"
	"github.com/jacorbello/parley/internal/hub"
	"github.com/jacorbello/parley/internal/poker"
	"github.com/jacorbello/parley/internal/standup"
	"github.com/jacorbello/parley/internal/store"
	"github.com/jacorbello/parley/web"
)

type app struct {
	pool          *pgxpool.Pool
	users         *store.Users
	spaces        *store.Spaces
	sessions      *store.Sessions
	hub           *hub.Hub
	secureCookies bool
	allowedOrigin string
	// authMode is ModeOpen or ModeOIDC; oidc is non-nil only in the latter.
	authMode string
	oidc     *auth.Provider
	// passcodeAttempts throttles room-code guessing at the join door.
	passcodeAttempts *attemptLimiter
}

type Options struct {
	SecureCookies bool
	AllowedOrigin string
	// AuthMode is ModeOpen (the default) or ModeOIDC.
	AuthMode string
	// OIDC must be set when AuthMode is ModeOIDC and is ignored otherwise.
	OIDC *auth.Provider
	// TrustProxyHeaders reads the client address from X-Forwarded-For and
	// friends. Turn it on only when a proxy in front overwrites those headers;
	// exposed directly, it hands every caller a free choice of address.
	TrustProxyHeaders bool
}

func Router(pool *pgxpool.Pool, opts Options) http.Handler {
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
		secureCookies: opts.SecureCookies,
		allowedOrigin: opts.AllowedOrigin,
		authMode:      mode,

		passcodeAttempts: newAttemptLimiter(),
	}
	if mode == ModeOIDC {
		a.oidc = opts.OIDC
	}
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

	r.Get("/readyz", func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte("database unreachable"))
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
		r.Use(resolvePrincipal(a.users))

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

		poker.New(a.pool, a.hub, a.broadcastState).Mount(r)
		standup.New(a.pool, a.hub, a.broadcastState).Mount(r)

		// requireSessionMember answers 404 for anonymous callers too, so these
		// routes sit outside RequireUser: a session's existence is never
		// disclosed to anyone outside its space.
		r.Route("/sessions/{id}", func(r chi.Router) {
			r.Use(a.requireSessionMember)
			r.Get("/", a.handleGetSession)
			r.Get("/export.csv", a.handleExportCSV)
			r.Post("/facilitator/claim", a.handleClaimFacilitator)
			r.Group(func(r chi.Router) {
				r.Use(requireFacilitator)
				r.Delete("/", a.handleCloseSession)
				r.Post("/reopen", a.handleReopenSession)
				r.Post("/facilitator", a.handleTransferFacilitator)
			})
		})
	})

	r.With(resolvePrincipal(a.users)).Get("/ws", a.handleWS)

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
