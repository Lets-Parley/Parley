package api

import (
	"encoding/csv"
	"net/http"

	"github.com/jacorbello/parley/internal/session"
)

func (a *app) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	env, err := session.BuildEnvelope(r.Context(), a.pool, a.hub, a.sessions, sess.ID)
	if err != nil {
		http.Error(w, `{"error":"could not load session"}`, http.StatusInternalServerError)
		return
	}
	rows, err := session.CSVRows(env)
	if err != nil {
		http.Error(w, `{"error":"this session kind has no export"}`, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		`attachment; filename="`+session.SanitizeFilename(sess.Title)+`.csv"`)
	cw := csv.NewWriter(w)
	cw.WriteAll(rows)
	cw.Flush()
}
