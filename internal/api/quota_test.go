package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func quotaServer(t *testing.T, limits Limits) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	return testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Limits: limits}), pool
}

func requestStatus(srv *httptest.Server, method, path, body string, cookie *http.Cookie) (int, error) {
	req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if err != nil {
		return 0, err
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

func concurrentStatuses(t *testing.T, attempts int, fn func(int) (int, error)) []int {
	t.Helper()
	type result struct {
		status int
		err    error
	}
	results := make(chan result, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			status, err := fn(i)
			results <- result{status: status, err: err}
		}(i)
	}
	wg.Wait()
	close(results)
	statuses := make([]int, 0, attempts)
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		statuses = append(statuses, result.status)
	}
	return statuses
}

func requireStatuses(t *testing.T, statuses []int, success, rejected, wantSuccess int) {
	t.Helper()
	gotSuccess := 0
	for _, status := range statuses {
		switch status {
		case success:
			gotSuccess++
		case rejected:
		default:
			t.Fatalf("status = %d, want %d or %d", status, success, rejected)
		}
	}
	if gotSuccess != wantSuccess {
		t.Fatalf("successful mutations = %d, want %d", gotSuccess, wantSuccess)
	}
}

func TestSpaceQuotaIsAtomicAtCreationBoundary(t *testing.T) {
	srv, pool := quotaServer(t, Limits{SpacesPerIdentity: 1})
	creator := signup(t, srv, "Creator")
	statuses := concurrentStatuses(t, 8, func(i int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/spaces", fmt.Sprintf(`{"name":"Space %d"}`, i), creator)
	})
	requireStatuses(t, statuses, http.StatusCreated, http.StatusConflict, 1)

	var count int
	if err := pool.QueryRow(context.Background(), "select count(*) from spaces").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored spaces = %d, want 1", count)
	}
}

func TestSessionQuotaIsAtomicAtCreationBoundary(t *testing.T) {
	srv, pool := quotaServer(t, Limits{SessionsPerSpace: 1})
	creator := signup(t, srv, "Creator")
	_, space := createSpace(t, srv, "Session Quota", creator)
	slug := space["slug"].(string)
	statuses := concurrentStatuses(t, 8, func(i int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/spaces/"+slug+"/sessions", fmt.Sprintf(`{"kind":"poker","title":"Session %d"}`, i), creator)
	})
	requireStatuses(t, statuses, http.StatusCreated, http.StatusConflict, 1)

	var count int
	if err := pool.QueryRow(context.Background(), "select count(*) from sessions").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored sessions = %d, want 1", count)
	}
}

func TestStoryQuotaIsAtomicInsideActiveSessionTransaction(t *testing.T) {
	srv, pool := quotaServer(t, Limits{StoriesPerSession: 1})
	creator := signup(t, srv, "Creator")
	_, space := createSpace(t, srv, "Story Quota", creator)
	resp, session := createSession(t, srv, space["slug"].(string), "poker", "Quota Session", creator)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session = %d", resp.StatusCode)
	}
	sessionID := session["id"].(string)
	statuses := concurrentStatuses(t, 8, func(i int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/sessions/"+sessionID+"/actions/stories", fmt.Sprintf(`{"title":"Story %d"}`, i), creator)
	})
	requireStatuses(t, statuses, http.StatusNoContent, http.StatusConflict, 1)

	var count int
	if err := pool.QueryRow(context.Background(), "select count(*) from stories where session_id = $1", sessionID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored stories = %d, want 1", count)
	}
}
