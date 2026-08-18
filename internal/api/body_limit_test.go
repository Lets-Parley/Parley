package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/httprequest"
)

func TestAPIRequestBodyLimitRejectsOversizedNoBodyMutation(t *testing.T) {
	handler := Router(nil, Options{})
	t.Cleanup(handler.Shutdown)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/example/reset", strings.NewReader(strings.Repeat("x", httprequest.MaxJSONBody+1)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized no-body mutation = %d, want 413", rec.Code)
	}
}

func TestAPIRequestBodyLimitRejectsOversizedTrailingDocument(t *testing.T) {
	handler := Router(nil, Options{})
	t.Cleanup(handler.Shutdown)
	body := `{"name":"Ada"}` + `{"padding":"` + strings.Repeat("x", httprequest.MaxJSONBody) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/me", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized trailing document = %d, want 413", rec.Code)
	}
}

func TestAPIRequestBodyLimitRejectsOversizedGet(t *testing.T) {
	handler := Router(nil, Options{})
	t.Cleanup(handler.Shutdown)
	req := httptest.NewRequest(http.MethodGet, "/api/auth", strings.NewReader(strings.Repeat("x", httprequest.MaxJSONBody+1)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized GET = %d, want 413", rec.Code)
	}
}

func TestAPIRequestBodyLimitPreservesBodylessGet(t *testing.T) {
	handler := Router(nil, Options{})
	t.Cleanup(handler.Shutdown)
	req := httptest.NewRequest(http.MethodGet, "/api/auth", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("bodyless GET = %d, want 200", rec.Code)
	}
}
