package api

import (
	"log/slog"
	"net/http"
	"net/netip"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/lets-parley/parley/internal/principal"
	"github.com/lets-parley/parley/internal/store"
)

// maxRequestIDLen is the longest inbound X-Request-Id a trusted proxy may
// supply. Generated ids are not clipped; this bound exists so a hostile
// header cannot flood logs or inject a newline past a naive length check.
const maxRequestIDLen = 128

// acceptTrustedRequestID drops an inbound X-Request-Id unless the socket
// peer is inside trusted and the value is short printable ASCII. It must
// run before middleware.RequestID, which honours whatever header remains,
// and before trustedProxyHeaders, which rewrites RemoteAddr to the client.
func acceptTrustedRequestID(trusted []netip.Prefix) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			inbound := r.Header.Get(middleware.RequestIDHeader)
			if inbound != "" && !honourInboundRequestID(r, trusted, inbound) {
				r.Header.Del(middleware.RequestIDHeader)
			}
			next.ServeHTTP(w, r)
		})
	}
}

func honourInboundRequestID(r *http.Request, trusted []netip.Prefix, id string) bool {
	if !validRequestID(id) {
		return false
	}
	peer, ok := parseClientAddress(r.RemoteAddr)
	return ok && addressInPrefixes(peer, trusted)
}

func validRequestID(id string) bool {
	if id == "" || len(id) > maxRequestIDLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if c < 0x20 || c > 0x7e {
			return false
		}
	}
	return true
}

// echoRequestID writes the id middleware.RequestID stored on the context
// back out as X-Request-Id. chi's middleware does not echo on its own.
func echoRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := middleware.GetReqID(r.Context()); id != "" {
			w.Header().Set(middleware.RequestIDHeader, id)
		}
		next.ServeHTTP(w, r)
	})
}

// withClientAddr stores the post-proxy client address on the context so
// custody and plugin audit writers, which hold only a context, emit the
// same address the rest of the app uses.
func withClientAddr(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(principal.WithClientAddr(r.Context(), clientKey(r))))
	})
}

// secEvent is one security-relevant action. Callers fill Event and Outcome
// (and Target/Org/Space when the request context does not already name them);
// the rest is read from the request so a cookie, passcode or body never has
// a field to land in.
type secEvent struct {
	Event        string
	Target       string
	Outcome      string
	Org          string
	Space        string
	ActorUserID  string
	ActorSubject string
}

func logSecEvent(r *http.Request, ev secEvent) {
	if ev.Outcome == "" {
		ev.Outcome = "ok"
	}
	if p, ok := PrincipalFrom(r.Context()); ok {
		if ev.ActorUserID == "" {
			ev.ActorUserID = p.UserID
		}
		if ev.ActorSubject == "" {
			ev.ActorSubject = p.AuditSubject()
		}
	}
	if ev.Org == "" {
		if v := r.Context().Value(orgKey{}); v != nil {
			ev.Org = v.(store.Org).Slug
		}
	}
	if ev.Space == "" {
		if v := r.Context().Value(spaceKey{}); v != nil {
			ev.Space = v.(store.Space).Slug
		} else if slug := chi.URLParam(r, "slug"); slug != "" {
			ev.Space = slug
		}
	}
	slog.InfoContext(r.Context(), "security event",
		"event", ev.Event,
		"actor_user_id", ev.ActorUserID,
		"actor_subject", ev.ActorSubject,
		"org", ev.Org,
		"space", ev.Space,
		"target", ev.Target,
		"outcome", ev.Outcome,
		"client_addr", clientKey(r),
		"request_id", middleware.GetReqID(r.Context()),
	)
}
