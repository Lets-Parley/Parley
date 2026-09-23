package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	if err := decodeStandupSchedule(w, r, &s); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	if err := s.Validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// Go and Postgres carry separate zone databases, and Postgres reads this
	// zone for away days and the trend, so both have to know it.
	if ok, err := a.schedules.ZoneReadable(r.Context(), s.Timezone); err != nil {
		http.Error(w, `{"error":"could not check the standup schedule's timezone"}`, http.StatusInternalServerError)
		return
	} else if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "timezone must be an IANA name such as America/New_York"})
		return
	}
	p, _ := PrincipalFrom(r.Context())
	if err := a.schedules.Put(r.Context(), spaceFrom(r.Context()).ID, p.UserID, s); err != nil {
		http.Error(w, `{"error":"could not save the standup schedule"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedule": s})
}

// decodeStandupSchedule is DecodeJSON with DisallowUnknownFields. The shared
// helper stays permissive: other handlers accept a body and ignore fields
// they do not read, and this schedule must not.
func decodeStandupSchedule(w http.ResponseWriter, r *http.Request, into any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, httprequest.MaxJSONBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return err
	}
	return fmt.Errorf("request body contains more than one JSON document")
}
