package api

import (
	"net/http"
	"testing"
)

func TestSetReadAndClearYourOwnAwayDays(t *testing.T) {
	srv, _ := trendServer(t)
	ada := signup(t, srv, "Ada")
	bea := signup(t, srv, "Bea")

	resp, body := doJSON(t, srv, http.MethodPost, "/api/me/away", `{"startsOn":"2026-10-05","endsOn":"2026-10-09"}`, ada)
	if resp.StatusCode != http.StatusCreated || body["startsOn"] != "2026-10-05" || body["endsOn"] != "2026-10-09" {
		t.Fatalf("add: got %d %v", resp.StatusCode, body)
	}
	id, _ := body["id"].(string)

	resp, body = doJSON(t, srv, http.MethodGet, "/api/me/away", "", ada)
	ranges, _ := body["ranges"].([]any)
	if resp.StatusCode != http.StatusOK || len(ranges) != 1 {
		t.Fatalf("ada's list: got %d %v", resp.StatusCode, body)
	}
	if _, body := doJSON(t, srv, http.MethodGet, "/api/me/away", "", bea); len(body["ranges"].([]any)) != 0 {
		t.Fatalf("bea sees ada's range: %v", body)
	}

	// Another person's id is not found, exactly like an id that is nowhere.
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/me/away/"+id, "", bea); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("bea deleting ada's range: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/me/away/not-a-uuid", "", ada); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("malformed id: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/me/away/"+id, "", ada); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("ada's own delete: got %d, want 204", resp.StatusCode)
	}
	if _, body := doJSON(t, srv, http.MethodGet, "/api/me/away", "", ada); len(body["ranges"].([]any)) != 0 {
		t.Fatalf("range survived its delete: %v", body)
	}
}

func TestAwayDaysAreValidated(t *testing.T) {
	srv, _ := trendServer(t) // today is 2026-09-23
	ada := signup(t, srv, "Ada")
	for _, bad := range []string{
		`{"startsOn":"2026-10-09","endsOn":"2026-10-05"}`,
		`{"startsOn":"2026-10-01","endsOn":"2027-01-15"}`,
		`{"startsOn":"2026-07-01","endsOn":"2026-07-02"}`,
		`{"startsOn":"2028-01-01","endsOn":"2028-01-02"}`,
		`{"startsOn":"monday","endsOn":"friday"}`,
		`{"startsOn":"2026-10-05","endsOn":"2026-10-09","userId":"someone-else"}`,
		`{}`,
	} {
		if resp, body := doJSON(t, srv, http.MethodPost, "/api/me/away", bad, ada); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: got %d %v, want 400", bad, resp.StatusCode, body)
		}
	}
	if resp, _ := doJSON(t, srv, http.MethodGet, "/api/me/away", "", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous: got %d, want 401", resp.StatusCode)
	}
}
