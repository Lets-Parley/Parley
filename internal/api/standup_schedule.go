package api

import (
	"net/http"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/standup"
)

func (a *app) handleGetStandupSchedule(w http.ResponseWriter, r *http.Request) {
	s, ok, err := a.schedules.Get(r.Context(), spaceFrom(r.Context()).ID)
	if err != nil {
		http.Error(w, `{"error":"could not load the standup schedule"}`, http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"schedule": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedule": s})
}

// handlePutStandupSchedule creates or replaces the space's schedule. Changes
// reach future slots only; a session already open is never touched.
func (a *app) handlePutStandupSchedule(w http.ResponseWriter, r *http.Request) {
	var s standup.Schedule
	if err := httprequest.DecodeStrictJSON(w, r, httprequest.MaxJSONBody, &s); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	if err := s.Validate(); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	// Go and Postgres carry separate zone databases, and Postgres reads this
	// zone for away days and the trend, so both have to know it.
	if ok, err := a.schedules.ZoneReadable(r.Context(), s.Timezone); err != nil {
		http.Error(w, `{"error":"could not check the standup schedule's timezone"}`, http.StatusInternalServerError)
		return
	} else if !ok {
		http.Error(w, `{"error":"timezone must be an IANA name such as America/New_York"}`, http.StatusBadRequest)
		return
	}
	p, _ := PrincipalFrom(r.Context())
	if err := a.schedules.Put(r.Context(), spaceFrom(r.Context()).ID, p.UserID, s); err != nil {
		http.Error(w, `{"error":"could not save the standup schedule"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedule": s})
}
