package poker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

// The field limits are character counts — that is what the columns'
// char_length checks enforce and what the client's maxLength counts.
// Measuring bytes instead rejected a perfectly legal story in any script
// that does not fit in one byte per character.

func TestAddStoryAcceptsMultiByteNotesAtTheCharacterLimit(t *testing.T) {
	pool, ac, _ := voteFixture(t)
	notes := strings.Repeat("い", 2000)

	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"title":"Story","notes":"`+notes+`"}`))
	rec := httptest.NewRecorder()
	addStory(rec, req, ac)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("2000-character notes status = %d (%s), want 204", rec.Code, rec.Body.String())
	}
	var got string
	if err := pool.QueryRow(context.Background(),
		"select notes from stories where session_id = $1 and title = 'Story'", ac.Session.ID,
	).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != notes {
		t.Fatalf("stored notes has %d characters, want %d", utf8.RuneCountInString(got), 2000)
	}
}

func TestAddStoryRejectsNotesOverTheCharacterLimit(t *testing.T) {
	_, ac, _ := voteFixture(t)

	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"title":"Story","notes":"`+strings.Repeat("い", 2001)+`"}`))
	rec := httptest.NewRecorder()
	addStory(rec, req, ac)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("2001-character notes status = %d, want 400", rec.Code)
	}
}

func TestPatchStoryAcceptsMultiByteFieldsAtTheCharacterLimit(t *testing.T) {
	for _, tc := range []struct {
		field string
		limit int
		body  func(value string) patchBody
		read  string
	}{
		{
			field: "notes",
			limit: 2000,
			body:  func(v string) patchBody { return patchBody{Notes: &v} },
			read:  "notes",
		},
		{
			field: "title",
			limit: 200,
			body:  func(v string) patchBody { return patchBody{Title: &v} },
			read:  "title",
		},
		{
			field: "ref",
			limit: 40,
			body:  func(v string) patchBody { return patchBody{Ref: &v} },
			read:  "ref",
		},
	} {
		t.Run(tc.field, func(t *testing.T) {
			pool, ac, storyID := voteFixture(t)
			value := strings.Repeat("い", tc.limit)

			rec := httptest.NewRecorder()
			applyPatch(rec, httptest.NewRequest(http.MethodPatch, "/", nil), ac, storyID, tc.body(value))

			if rec.Code != http.StatusNoContent {
				t.Fatalf("%d-character %s status = %d (%s), want 204", tc.limit, tc.field, rec.Code, rec.Body.String())
			}
			var got string
			if err := pool.QueryRow(context.Background(),
				"select "+tc.read+" from stories where id = $1", storyID,
			).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != value {
				t.Fatalf("stored %s has %d characters, want %d", tc.field, utf8.RuneCountInString(got), tc.limit)
			}
		})
	}
}

func TestPatchStoryRejectsFieldsOverTheCharacterLimit(t *testing.T) {
	for _, tc := range []struct {
		field string
		over  int
		body  func(value string) patchBody
	}{
		{
			field: "notes",
			over:  2001,
			body:  func(v string) patchBody { return patchBody{Notes: &v} },
		},
		{
			field: "title",
			over:  201,
			body:  func(v string) patchBody { return patchBody{Title: &v} },
		},
		{
			field: "ref",
			over:  41,
			body:  func(v string) patchBody { return patchBody{Ref: &v} },
		},
	} {
		t.Run(tc.field, func(t *testing.T) {
			_, ac, storyID := voteFixture(t)

			rec := httptest.NewRecorder()
			applyPatch(rec, httptest.NewRequest(http.MethodPatch, "/", nil), ac, storyID,
				tc.body(strings.Repeat("い", tc.over)))

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%d-character %s status = %d, want 400", tc.over, tc.field, rec.Code)
			}
		})
	}
}

func TestAddStoryAcceptsMultiByteTitleAndRefAtTheCharacterLimit(t *testing.T) {
	pool, ac, _ := voteFixture(t)
	title := strings.Repeat("い", 200)
	ref := strings.Repeat("あ", 40)

	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"title":"`+title+`","ref":"`+ref+`"}`))
	rec := httptest.NewRecorder()
	addStory(rec, req, ac)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("full-length multi-byte identity status = %d (%s), want 204", rec.Code, rec.Body.String())
	}
	var gotTitle, gotRef string
	if err := pool.QueryRow(context.Background(),
		"select title, ref from stories where session_id = $1 and title = $2", ac.Session.ID, title,
	).Scan(&gotTitle, &gotRef); err != nil {
		t.Fatal(err)
	}
	if gotTitle != title || gotRef != ref {
		t.Fatalf("stored title=%d chars ref=%d chars, want 200 and 40",
			utf8.RuneCountInString(gotTitle), utf8.RuneCountInString(gotRef))
	}
}
