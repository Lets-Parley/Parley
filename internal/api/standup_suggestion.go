package api

import (
	"net/http"

	"github.com/lets-parley/parley/internal/standup"
)

func (a *app) handleStandupSuggestion(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if sess.Kind != "standup" || sess.Phase == "done" {
		http.Error(w, `{"error":"no active standup"}`, http.StatusNotFound)
		return
	}
	p, _ := PrincipalFrom(r.Context())
	text, err := standup.YesterdaySuggestion(r.Context(), a.pool, sess, p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load your standup suggestion"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"yesterday": text})
}
