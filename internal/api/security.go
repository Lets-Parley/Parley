package api

import (
	"net/http"
)

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

// rejectCrossSite blocks cross-origin non-GET API requests. Browsers do not let
// cross-site pages read responses, but they can send them — this stops the send.
func rejectCrossSite(allowedOrigin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				if o := r.Header.Get("Origin"); o != "" && o != allowedOrigin {
					http.Error(w, `{"error":"cross-site request rejected"}`, http.StatusForbidden)
					return
				}
				if sfs := r.Header.Get("Sec-Fetch-Site"); sfs == "cross-site" {
					http.Error(w, `{"error":"cross-site request rejected"}`, http.StatusForbidden)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
