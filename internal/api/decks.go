package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/poker"
	"github.com/lets-parley/parley/internal/store"
)

// deckBody is a deck as a space owner submits it. The specials ("?", "coffee")
// are the server's and are never part of it.
type deckBody struct {
	Name    string   `json:"name"`
	Cards   []string `json:"cards"`
	Ordinal bool     `json:"ordinal"`
}

// readDeckBody decodes and validates a submitted deck. Validation is
// poker.Deck's own rule — the same one the session-create path runs — so a
// deck that stores cleanly is a deck a session can be created from, and the
// two can never disagree about what a legal card is.
func readDeckBody(w http.ResponseWriter, r *http.Request) (deckBody, bool) {
	var body deckBody
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return deckBody{}, false
	}
	if err := poker.NewDeck(body.Name, body.Cards, body.Ordinal).Validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return deckBody{}, false
	}
	return body, true
}

func (a *app) handleListDecks(w http.ResponseWriter, r *http.Request) {
	decks, err := a.decks.ForSpace(r.Context(), spaceFrom(r.Context()).ID)
	if err != nil {
		http.Error(w, `{"error":"could not load decks"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, decks)
}

func (a *app) handleCreateDeck(w http.ResponseWriter, r *http.Request) {
	body, ok := readDeckBody(w, r)
	if !ok {
		return
	}
	deck, err := a.decks.Create(r.Context(), spaceFrom(r.Context()).ID, body.Name, body.Cards, body.Ordinal, a.limits.DecksPerSpace)
	if writeDeckError(w, err) {
		return
	}
	writeJSON(w, http.StatusCreated, deck)
}

func (a *app) handleUpdateDeck(w http.ResponseWriter, r *http.Request) {
	body, ok := readDeckBody(w, r)
	if !ok {
		return
	}
	deck, err := a.decks.Update(r.Context(), spaceFrom(r.Context()).ID, chi.URLParam(r, "deckId"), body.Name, body.Cards, body.Ordinal)
	if writeDeckError(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, deck)
}

func (a *app) handleDeleteDeck(w http.ResponseWriter, r *http.Request) {
	err := a.decks.Delete(r.Context(), spaceFrom(r.Context()).ID, chi.URLParam(r, "deckId"))
	if writeDeckError(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeDeckError turns the store's errors into answers a client can act on and
// reports whether it wrote one. The cap and the per-space name collision both
// have to land as 4xx: they are things the caller can fix, and a raw pg error
// reaching the generic branch would serve a 500 for a request that was merely
// refused.
func writeDeckError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrNoDeck):
		http.Error(w, `{"error":"no such deck"}`, http.StatusNotFound)
	case errors.Is(err, store.ErrDeckNameTaken):
		http.Error(w, `{"error":"this space already has a deck with that name"}`, http.StatusConflict)
	case errors.Is(err, store.ErrQuotaExceeded):
		http.Error(w, `{"error":"deck limit reached for this space"}`, http.StatusConflict)
	default:
		http.Error(w, `{"error":"could not save deck"}`, http.StatusInternalServerError)
	}
	return true
}
