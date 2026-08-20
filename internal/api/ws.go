package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/lets-parley/parley/internal/hub"
	"github.com/lets-parley/parley/internal/store"
)

// handleWS authorizes and upgrades /ws?session=:id. Membership is enforced here
// exactly as on REST; the browser's same-origin policy does not cover
// WebSockets, so the Origin check is load-bearing.
func (a *app) handleWS(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	tokenSession, err := a.users.ResolveToken(r.Context(), []byte(p.TokenID))
	if errors.Is(err, store.ErrNoUser) {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "could not validate session", http.StatusInternalServerError)
		return
	}
	if tokenSession.User.ID != p.UserID {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	sessionID := r.URL.Query().Get("session")
	sess, err := a.sessions.ByID(r.Context(), sessionID)
	if errors.Is(err, store.ErrNoSession) || sessionID == "" {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "could not load session", http.StatusInternalServerError)
		return
	}
	member, err := a.spaces.IsMember(r.Context(), sess.SpaceID, p.UserID)
	if err != nil || !member {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			o := r.Header.Get("Origin")
			return o == "" || o == a.allowedOrigin
		},
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	env, err := a.kinds.BuildEnvelope(r.Context(), a.pool, a.presence, a.sessions, sess.ID)
	var initial []byte
	if err == nil {
		initial, _ = json.Marshal(env)
	}
	a.hub.AttachAuthenticated(ws, sess.ID, p.UserID, initial, hub.SessionAuth{
		TokenID: string(p.TokenID), SpaceID: sess.SpaceID, ExpiresAt: tokenSession.ExpiresAt,
	})
}
