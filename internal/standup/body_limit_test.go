package standup

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/session"
)

func TestPutEntryReturnsPayloadTooLargeForOversizedJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"today":"`+strings.Repeat("x", 64<<10)+`"}`))
	rec := httptest.NewRecorder()

	putEntry(rec, req, session.ActionCtx{})

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized JSON status = %d, want 413", rec.Code)
	}
}
