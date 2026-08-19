package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The question /version answers — "am I running the patched build?" — has to be
// answerable before Postgres is up, so the route is built with a nil pool and
// called with no cookie and no session.
func TestVersionNeedsNoDatabase(t *testing.T) {
	r := Router(nil, Options{Version: "1.2.3"})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/version", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if body.Version != "1.2.3" {
		t.Fatalf("version = %q, want 1.2.3", body.Version)
	}
}

// An unstamped build must be honest rather than empty.
func TestVersionDefaultsToDev(t *testing.T) {
	rec := httptest.NewRecorder()
	Router(nil, Options{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/version", nil))

	if got := rec.Body.String(); got != `{"version":"dev"}`+"\n" {
		t.Fatalf("body = %q, want the dev default", got)
	}
}
