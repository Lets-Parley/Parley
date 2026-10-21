package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/standup"
)

type icsTokenKey struct{}

// redactICSPath copies the feed token onto the context, then rewrites the
// request path so a log line, a security event, or a panic report cannot
// repeat it. Chi has already captured the parameter; that copy is overwritten
// too.
func redactICSPath(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		if rc := chi.RouteContext(r.Context()); rc != nil {
			for i, key := range rc.URLParams.Keys {
				if key == "token" {
					rc.URLParams.Values[i] = "[redacted]"
				}
			}
		}
		r.URL.Path = "/ics/[redacted]"
		r.URL.RawPath = ""
		r.RequestURI = "/ics/[redacted]"
		ctx := context.WithValue(r.Context(), icsTokenKey{}, token)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *app) handleGetICS(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}
	active, minutes, err := a.ics.Active(r.Context(), p.UserID)
	if err != nil {
		slog.Error("could not read ics feed", "error", err)
		http.Error(w, `{"error":"could not read calendar feed"}`, http.StatusInternalServerError)
		return
	}
	if !active {
		writeJSON(w, http.StatusOK, map[string]any{"active": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"active": true, "remindMinutes": minutes})
}

func (a *app) handleMintICS(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}
	var body struct {
		RemindMinutes *int `json:"remindMinutes"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	if body.RemindMinutes == nil || *body.RemindMinutes < standup.RemindMinutesMin || *body.RemindMinutes > standup.RemindMinutesMax {
		http.Error(w, `{"error":"remindMinutes must be between 0 and 1440"}`, http.StatusBadRequest)
		return
	}
	plain, err := a.ics.Mint(r.Context(), p.UserID, *body.RemindMinutes)
	if err != nil {
		slog.Error("could not mint ics feed", "error", err)
		http.Error(w, `{"error":"could not create calendar feed"}`, http.StatusInternalServerError)
		return
	}
	logSecEvent(r, secEvent{Event: "ics.mint", Target: p.UserID})
	writeJSON(w, http.StatusOK, map[string]any{
		"url":           a.allowedOrigin + "/ics/" + plain,
		"remindMinutes": *body.RemindMinutes,
	})
}

func (a *app) handleRevokeICS(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}
	if err := a.ics.Revoke(r.Context(), p.UserID); err != nil {
		slog.Error("could not revoke ics feed", "error", err)
		http.Error(w, `{"error":"could not revoke calendar feed"}`, http.StatusInternalServerError)
		return
	}
	logSecEvent(r, secEvent{Event: "ics.revoke", Target: p.UserID})
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleICSFeed(w http.ResponseWriter, r *http.Request) {
	token, _ := r.Context().Value(icsTokenKey{}).(string)
	if a.ics == nil {
		logSecEvent(r, secEvent{Event: "ics.feed", Outcome: "not_found", Target: "/ics/[redacted]"})
		http.NotFound(w, r)
		return
	}
	userID, remind, ok, err := a.ics.Lookup(r.Context(), token)
	if err != nil {
		slog.Error("could not resolve ics feed", "error", err)
		logSecEvent(r, secEvent{Event: "ics.feed", Outcome: "error", Target: "/ics/[redacted]"})
		http.Error(w, "calendar unavailable", http.StatusInternalServerError)
		return
	}
	if !ok {
		logSecEvent(r, secEvent{Event: "ics.feed", Outcome: "not_found", Target: "/ics/[redacted]"})
		http.NotFound(w, r)
		return
	}
	events, err := a.ics.Events(r.Context(), userID, a.allowedOrigin, a.now())
	if err != nil {
		slog.Error("could not build ics feed", "error", err)
		logSecEvent(r, secEvent{Event: "ics.feed", Outcome: "error", Target: "/ics/[redacted]"})
		http.Error(w, "calendar unavailable", http.StatusInternalServerError)
		return
	}
	logSecEvent(r, secEvent{
		Event: "ics.feed", Outcome: "ok", ActorUserID: userID, Target: "/ics/[redacted]",
	})
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(standup.RenderCalendar(a.now(), remind, events)))
}
