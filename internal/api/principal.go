package api

import (
	"context"
	"net/http"

	"github.com/lets-parley/parley/internal/principal"
	"github.com/lets-parley/parley/internal/store"
)

const sessionCookie = "parley_session"

type Principal = principal.Principal

func PrincipalFrom(ctx context.Context) (Principal, bool) {
	return principal.From(ctx)
}

// resolvePrincipal attaches a Principal to the context when a valid session
// cookie is present. It never rejects; handlers that need identity use
// RequireUser.
//
// federatedOnly turns an instance's switch to an identity provider into
// something that actually takes effect. Refusing to mint new anonymous
// identities does nothing about the ones already minted: their tokens stay
// valid for the whole idle window, so without this an instance that turned
// sign-in on would keep admitting everyone who had ever opened it.
func resolvePrincipal(users *store.Users, federatedOnly bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if c, err := r.Cookie(sessionCookie); err == nil {
				if hash, err := store.HashToken(c.Value); err == nil {
					// A read resolves the principal without renewing the
					// idle window. rejectCrossSite waves GETs through, so a
					// touching GET would let any third-party page keep a
					// victim's session alive indefinitely and write to
					// session_tokens on every visit. HEAD is routed to the
					// same handlers, so it is held to the same rule.
					// Sessions still stay alive on real use: every write, and
					// every WebSocket connect, touches the row.
					touch := r.Method != http.MethodGet && r.Method != http.MethodHead
					if sess, err := users.ResolveToken(r.Context(), hash, touch); err == nil {
						// A link guest resolves under an identity provider too,
						// by explicit exception rather than by pretending to be
						// federated: signed links are otherwise dead on exactly
						// the instances that most want to hand one to an
						// outsider who will never have an account.
						if !federatedOnly || sess.User.Issuer != "" || sess.User.LinkSessionID != "" {
							r = r.WithContext(principal.With(r.Context(), Principal{
								UserID: sess.User.ID, Display: sess.User.Name,
								TokenID: string(hash), TokenExpiresAt: sess.ExpiresAt,
								AvatarIcon:    sess.User.AvatarIcon,
								LinkSessionID: sess.User.LinkSessionID,
								Subject:       sess.User.Subject,
							}))
						}
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireUser admits an ordinary account. A link guest is not one: its
// capability is one room, and nothing behind this middleware is scoped to a
// room, so it is turned away as if it were not signed in at all.
func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := PrincipalFrom(r.Context()); !ok || p.IsLinkGuest() {
			http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// rejectLinkPrincipal shuts a route to link guests. It guards the routes that
// sit outside RequireUser and would otherwise admit one: the identity routes,
// the public space view, and — inside the bound room — the facilitator
// controls, the CSV export and the link routes themselves. A link is a
// capability to take part in one meeting, never a foothold to grow.
func rejectLinkPrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := PrincipalFrom(r.Context()); ok && p.IsLinkGuest() {
			http.Error(w, `{"error":"a guest joining by link cannot do that"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// setLinkSessionCookie is the ordinary session cookie with no lifetime at all:
// no Max-Age and no Expires, so the browser drops it when the browsing session
// ends. A guest link is aimed at someone outside the team, often on a borrowed
// or shared machine, and the seat should not sit valid for a day after they
// walk away.
//
// The browsing session is the browser, not the tab. Closing the room tab while
// another window of that browser is open leaves this cookie alive, so the next
// person to open the room URL is recovered into the same seat. What genuinely
// ends the seat is quitting the browser, the link's own expiry — which the
// token behind the cookie carries, whatever the browser decides to keep — or
// Leave room, which deletes the token server-side. A refresh or an in-meeting
// navigation is unaffected, which is the reason the seat is not torn down on
// page hide.
func setLinkSessionCookie(w http.ResponseWriter, value string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
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
