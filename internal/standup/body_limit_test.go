package standup

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

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

// The field limit is 2000 *characters* — that is what the column's
// char_length check enforces and what the client's maxLength counts. Measuring
// bytes instead rejected a perfectly legal entry in any script that does not
// fit in one byte per character, and the rejection surfaced as a failed
// autosave. All three fields (yesterday, today, blockers) share the same
// check, so each is pinned independently in both directions here.
func TestPutEntryAcceptsMultiByteEntryAtTheCharacterLimit(t *testing.T) {
	for _, tc := range []struct {
		field  string
		column string
	}{
		{"yesterday", "yesterday"},
		{"today", "today"},
		{"blockers", "blockers"},
	} {
		t.Run(tc.field, func(t *testing.T) {
			pool := testPool(t)
			sess, ids := seed(t, pool, `{}`, "Dana Whitfield")
			entry := strings.Repeat("い", 2000)

			req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"`+tc.field+`":"`+entry+`"}`))
			rec := httptest.NewRecorder()

			putEntry(rec, req, session.ActionCtx{
				Pool:      pool,
				Session:   sess,
				UserID:    ids[0],
				Broadcast: func(context.Context, string) {},
			})

			if rec.Code != http.StatusNoContent {
				t.Fatalf("2000-character %s status = %d (%s), want 204", tc.field, rec.Code, rec.Body.String())
			}
			var got string
			if err := pool.QueryRow(context.Background(),
				"select "+tc.column+" from standup_entries where session_id = $1 and user_id = $2", sess.ID, ids[0],
			).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != entry {
				t.Fatalf("stored %s has %d characters, want %d", tc.field, utf8.RuneCountInString(got), 2000)
			}
		})
	}
}

// One character past the limit is still refused, in characters as well, for
// every field.
func TestPutEntryRejectsEntryOverTheCharacterLimit(t *testing.T) {
	for _, field := range []string{"yesterday", "today", "blockers"} {
		t.Run(field, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"`+field+`":"`+strings.Repeat("い", 2001)+`"}`))
			rec := httptest.NewRecorder()

			putEntry(rec, req, session.ActionCtx{})

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("2001-character %s status = %d, want 400", field, rec.Code)
			}
		})
	}
}
