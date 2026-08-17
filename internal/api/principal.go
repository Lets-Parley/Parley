package api

import (
	"context"
	"net/http"

	"github.com/jacorbello/parley/internal/store"
)

const sessionCookie = "parley_session"

type Principal struct {
	UserID  string
	Display string
}

type ctxKey struct{}

func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}

// resolvePrincipal attaches a Principal to the context when a valid session
// cookie is present. It never rejects; handlers that need identity use
// RequireUser.
func resolvePrincipal(users *store.Users) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if c, err := r.Cookie(sessionCookie); err == nil {
				if hash, err := store.HashToken(c.Value); err == nil {
					if u, err := users.ByToken(r.Context(), hash); err == nil {
						ctx := context.WithValue(r.Context(), ctxKey{}, Principal{UserID: u.ID, Display: u.Name})
						r = r.WithContext(ctx)
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := PrincipalFrom(r.Context()); !ok {
			http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func setSessionCookie(w http.ResponseWriter, value string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   int((90 * 24 * 3600)),
	})
}

func clearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   -1,
	})
}
