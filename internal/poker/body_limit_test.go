package poker

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeReturnsPayloadTooLargeForOversizedJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"title":"`+strings.Repeat("x", 64<<10)+`"}`))
	rec := httptest.NewRecorder()
	var body map[string]any

	if decode(rec, req, &body) {
		t.Fatal("oversized body decoded successfully")
	}
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized JSON status = %d, want 413", rec.Code)
	}
}
