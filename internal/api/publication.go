package api

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/poker/publication"
)

func (a *app) publicationScope(r *http.Request) (publication.Scope, error) {
	s := sessionFrom(r.Context())
	p, _ := PrincipalFrom(r.Context())
	scope := publication.Scope{SpaceID: s.SpaceID, SessionID: s.ID, PrincipalID: p.UserID}
	err := a.pool.QueryRow(r.Context(), `select sp.org_id::text from sessions s join spaces sp on sp.id=s.space_id join members m on m.space_id=sp.id and m.user_id=$2 join org_members om on om.org_id=sp.org_id and om.user_id=$2 join users u on u.id=$2 where s.id=$1 and s.kind='poker' and s.facilitator_id=$2 and om.revoked_at is null and u.link_id is null`, s.ID, p.UserID).Scan(&scope.OrgID)
	return scope, err
}
func publicationJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := httprequest.DecodeJSON(w, r, 64<<10, v); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return false
	}
	return true
}
func publicationPaused(w http.ResponseWriter) {
	http.Error(w, `{"error":"publication paused; check connection access, current split and review again"}`, http.StatusConflict)
}
func (a *app) publicationHandler(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { a.handlePublication(w, r, path) }
}

func (a *app) handlePublication(w http.ResponseWriter, r *http.Request, path string) {
	scope, err := a.publicationScope(r)
	if err != nil {
		http.Error(w, `{"error":"publication is unavailable for this account and room"}`, http.StatusForbidden)
		return
	}
	if path == "connection" && r.Method == http.MethodGet {
		available := a.publications != nil
		var binding *publication.Capability
		writeConsent := false
		if available {
			if conn, err := a.publications.Resolve(r.Context(), scope); err == nil {
				binding = &conn.Capability
				writeConsent = conn.WriteConsent
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"available": available, "binding": binding, "writeConsent": writeConsent})
		return
	}
	if path == "connection" && r.Method == http.MethodDelete {
		if a.publications == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if err = a.publications.Revoke(r.Context(), scope); err != nil {
			publicationPaused(w)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if a.publications == nil {
		http.Error(w, `{"error":"publication requires encrypted secret storage; ask the operator to configure PLUGIN_SECRET_KEY"}`, http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	provider := a.publications.Provider()
	engine := &publication.Engine{Pool: a.pool, Provider: provider}
	if path == "connection" {
		var body struct {
			publication.ConnectionConfig
			Token string `json:"token"`
		}
		if !publicationJSON(w, r, &body) {
			return
		}
		if err = a.publications.Connect(ctx, scope, body.ConnectionConfig, body.Token); err != nil {
			publicationPaused(w)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if path == "reviews" && r.Method == http.MethodGet {
		rows, err := a.pool.Query(ctx, `select id::text,parent_id::text from poker_publication_reviews where session_id=$1 and principal_id=$2 order by revision desc limit 50`, scope.SessionID, scope.PrincipalID)
		if err != nil {
			publicationPaused(w)
			return
		}
		defer rows.Close()
		out := []map[string]string{}
		for rows.Next() {
			var id, parent string
			if rows.Scan(&id, &parent) != nil {
				publicationPaused(w)
				return
			}
			out = append(out, map[string]string{"id": id, "parentId": parent})
		}
		if rows.Err() != nil {
			publicationPaused(w)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	if path == "preview" || path == "approve" {
		var body struct {
			ParentID     string   `json:"parentId"`
			Children     []string `json:"children"`
			Fingerprint  string   `json:"fingerprint"`
			WriteConsent bool     `json:"writeConsent"`
		}
		if !publicationJSON(w, r, &body) {
			return
		}
		req := publication.Request{ParentID: body.ParentID, Children: body.Children, Fingerprint: body.Fingerprint}
		var review publication.Review
		if path == "preview" {
			review, err = engine.Preview(ctx, scope, req)
		} else {
			conn, resolveErr := a.publications.Resolve(ctx, scope)
			if !body.WriteConsent || resolveErr != nil || !conn.WriteConsent {
				publicationPaused(w)
				return
			}
			review, err = engine.Approve(ctx, scope, req)
		}
		if err != nil {
			publicationPaused(w)
			return
		}
		writeJSON(w, http.StatusOK, review)
		return
	}
	review := chi.URLParam(r, "reviewId")
	switch path {
	case "receipts":
		receipts, err := engine.Receipts(ctx, scope, review)
		if err != nil {
			publicationPaused(w)
			return
		}
		writeJSON(w, http.StatusOK, receipts)
	case "run":
		var body struct {
			WriteConsent bool `json:"writeConsent"`
		}
		if !publicationJSON(w, r, &body) {
			return
		}
		if !body.WriteConsent {
			publicationPaused(w)
			return
		}
		if err = engine.Run(ctx, scope, review); err != nil {
			publicationPaused(w)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case "verify":
		if err = engine.Verify(ctx, scope, review); err != nil {
			publicationPaused(w)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}
