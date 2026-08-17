package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/hub"
	"github.com/jacorbello/parley/internal/poker"
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
}

func Router(pool *pgxpool.Pool, secureCookies bool, allowedOrigin string) http.Handler {
	a := &app{
		pool:          pool,
		users:         &store.Users{Pool: pool},
		spaces:        &store.Spaces{Pool: pool},
		sessions:      &store.Sessions{Pool: pool},
		hub:           hub.New(),
		secureCookies: secureCookies,
		allowedOrigin: allowedOrigin,
	}
	a.hub.OnPresenceChange = func(sessionID string) {
		a.broadcastState(context.Background(), sessionID)
	}
	a.hub.OnFacilitatorSeen = func(sessionID, userID string) {
		a.sessions.TouchFacilitatorSeen(context.Background(), sessionID, userID)
	}

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
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

	r.Route("/api", func(r chi.Router) {
		r.Use(rejectCrossSite(a.allowedOrigin))
		r.Use(requireJSONBody)
		r.Use(resolvePrincipal(a.users))

		r.Post("/me", a.handlePostMe)
		r.Get("/me", a.handleGetMe)
		r.Delete("/me", a.handleDeleteMe)

		r.Get("/spaces/{slug}", a.handleGetSpace)
		r.Group(func(r chi.Router) {
			r.Use(RequireUser)
			r.Post("/spaces", a.handleCreateSpace)
			r.Post("/spaces/{slug}/join", a.handleJoinSpace)
			r.Post("/spaces/{slug}/sessions", a.handleCreateSession)
		})

		poker.New(a.pool, a.hub, a.broadcastState).Mount(r)

		// requireSessionMember answers 404 for anonymous callers too, so these
		// routes sit outside RequireUser: a session's existence is never
		// disclosed to anyone outside its space.
		r.Route("/sessions/{id}", func(r chi.Router) {
			r.Use(a.requireSessionMember)
			r.Get("/", a.handleGetSession)
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
