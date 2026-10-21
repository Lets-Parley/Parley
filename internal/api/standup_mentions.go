package api

import (
	"net/http"

	"github.com/lets-parley/parley/internal/standup"
)

// handleSessionMentions answers the caller's own "needs you" list, and whom
// they have asked, for one room. It is a route of its own rather than part of
// the envelope because the envelope is broadcast to everybody in the room.
// Mounted behind rejectLinkPrincipal: a guest is never asked and never asks.
func (a *app) handleSessionMentions(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	sess := sessionFrom(r.Context())
	needsYou, asked, err := standup.Mentions(r.Context(), a.pool, sess.ID, p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load your mentions"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"needsYou": needsYou, "asked": asked})
}
