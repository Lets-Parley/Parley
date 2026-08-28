package api

import (
	"net/http"
)

// handleListMyOrgs lists the orgs the caller belongs to. It is what fills the
// org switcher, and what tells a client to show the no-org dead-end instead:
// an empty array is a real answer for a signed-in account whose identity
// provider handed it no claim any org here registered.
//
// Cross-org by definition, so it is one of the two routes that stay outside
// /api/orgs/{org} — asking it to name an org first would be circular.
func (a *app) handleListMyOrgs(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	orgs, err := a.orgs.ForUser(r.Context(), p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load your orgs"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, orgs)
}
