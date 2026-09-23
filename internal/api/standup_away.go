package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/standup"
)

// A person's own away days. Every handler acts on the caller's user id only:
// there is no way to name somebody else, so nobody can mark a teammate away
// or read their ranges.

func (a *app) handleListAway(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}
	ranges, err := a.away.List(r.Context(), p.UserID)
	if err != nil {
		slog.Error("could not list away days", "error", err)
		http.Error(w, `{"error":"could not load your away days"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ranges": ranges})
}

func (a *app) handleAddAway(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}
	var body struct {
		StartsOn string `json:"startsOn"`
		EndsOn   string `json:"endsOn"`
	}
	// Strict, like the schedule: a stray "userId" is refused rather than
	// silently ignored, so nobody believes they set it for someone else.
	if err := decodeStandupSchedule(w, r, &body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}
	start, end, err := standup.ValidateAway(body.StartsOn, body.EndsOn, a.now())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	added, err := a.away.Add(r.Context(), p.UserID, start, end)
	if errors.Is(err, standup.ErrTooManyAway) {
		http.Error(w, `{"error":"you already have 20 away ranges; remove one first"}`, http.StatusConflict)
		return
	}
	if err != nil {
		slog.Error("could not add away days", "error", err)
		http.Error(w, `{"error":"could not save your away days"}`, http.StatusInternalServerError)
		return
	}
	a.refreshAwayRooms(r.Context(), p.UserID)
	writeJSON(w, http.StatusCreated, added)
}

func (a *app) handleDeleteAway(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
		return
	}
	found, err := a.away.Delete(r.Context(), p.UserID, chi.URLParam(r, "id"))
	if err != nil {
		slog.Error("could not delete away days", "error", err)
		http.Error(w, `{"error":"could not remove those away days"}`, http.StatusInternalServerError)
		return
	}
	if !found {
		http.Error(w, `{"error":"away range not found"}`, http.StatusNotFound)
		return
	}
	a.refreshAwayRooms(r.Context(), p.UserID)
	w.WriteHeader(http.StatusNoContent)
}

// refreshAwayRooms pushes new state to each open async standup today in the
// caller's spaces, after their away write has committed, so the digest moves
// them in or out of "Away" without a reload. Best-effort: the range is saved
// whatever happens here, so a failure is logged and the request still succeeds.
// It runs on the request's goroutine, not its own, so it needs no hub.track.
func (a *app) refreshAwayRooms(ctx context.Context, userID string) {
	ids, err := standup.BumpAwayRooms(ctx, a.pool, userID)
	if err != nil {
		slog.Warn("could not refresh open standups after an away change", "error", err)
		return
	}
	for _, id := range ids {
		a.broadcastState(ctx, id)
	}
}

// handleStandupTrend is the space's team participation trend. It takes no
// parameters: the window is fixed so it cannot be moved to difference weeks.
func (a *app) handleStandupTrend(w http.ResponseWriter, r *http.Request) {
	weeks, err := standup.Trend(r.Context(), a.pool, spaceFrom(r.Context()).ID, a.now())
	if err != nil {
		slog.Error("could not compute standup trend", "error", err)
		http.Error(w, `{"error":"could not load the participation trend"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"weeks": weeks})
}
