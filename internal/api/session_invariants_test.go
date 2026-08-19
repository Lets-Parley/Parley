package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func delayedJSONRequest(srv *httptest.Server, method, path, body string, cookie *http.Cookie) <-chan int {
	result := make(chan int, 1)
	go func() {
		req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if err != nil {
			result <- 0
			return
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			result <- 0
			return
		}
		resp.Body.Close()
		result <- resp.StatusCode
	}()
	return result
}

func waitForBlockedMutation(t *testing.T, pool *pgxpool.Pool, result <-chan int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case status := <-result:
			t.Fatalf("mutation returned %d before reaching the locked SQL boundary", status)
		default:
		}
		var blocked bool
		if err := pool.QueryRow(context.Background(), `
			select exists (
				select 1 from pg_stat_activity
				where pid <> pg_backend_pid() and wait_event_type = 'Lock'
			)`).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("mutation did not reach a blocked SQL boundary")
}

func TestFormerFacilitatorCannotFinishDelayedStoryMutation(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "Delayed Authority Space")
	addStory(t, srv, id, "Existing story", fac)
	_, memberBody := doJSON(t, srv, http.MethodGet, "/api/me", "", member)

	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), "select id from sessions where id = $1 for update", id); err != nil {
		t.Fatal(err)
	}
	result := delayedJSONRequest(srv, http.MethodPost, "/api/sessions/"+id+"/actions/stories", `{"title":"Delayed story"}`, fac)
	waitForBlockedMutation(t, pool, result)
	if _, err := tx.Exec(context.Background(), "update sessions set facilitator_id = $2 where id = $1", id, memberBody["id"]); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if status := <-result; status != http.StatusForbidden {
		t.Fatalf("delayed story mutation status = %d, want 403", status)
	}

	var storyCount int
	if err := pool.QueryRow(context.Background(), "select count(*) from stories where session_id = $1", id).Scan(&storyCount); err != nil {
		t.Fatal(err)
	}
	if storyCount != 1 {
		t.Fatalf("stories = %d, want only the original story", storyCount)
	}
}

func TestPokerMutationsCannotFinishAfterDelayedClosure(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "Delayed Poker Closure Space")
	story := addStory(t, srv, id, "Voting story", fac)
	selectStory(t, srv, id, story, fac)

	tests := []struct {
		name       string
		method     string
		path       string
		body       string
		cookie     *http.Cookie
		assertNone func(*testing.T)
	}{
		{
			name:   "story",
			method: http.MethodPost,
			path:   "/api/sessions/" + id + "/actions/stories",
			body:   `{"title":"Too late"}`,
			cookie: fac,
			assertNone: func(t *testing.T) {
				var count int
				if err := pool.QueryRow(context.Background(), "select count(*) from stories where session_id = $1", id).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 1 {
					t.Fatalf("stories = %d, want 1", count)
				}
			},
		},
		{
			name:   "vote",
			method: http.MethodPost,
			path:   "/api/sessions/" + id + "/actions/vote",
			body:   `{"storyId":"` + story + `","value":"5"}`,
			cookie: member,
			assertNone: func(t *testing.T) {
				var count int
				if err := pool.QueryRow(context.Background(), "select count(*) from votes where story_id = $1", story).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 0 {
					t.Fatalf("votes = %d, want 0", count)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := pool.Exec(context.Background(), "update sessions set ended_at = null where id = $1", id); err != nil {
				t.Fatal(err)
			}
			tx, err := pool.Begin(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(context.Background(), "select id from sessions where id = $1 for update", id); err != nil {
				t.Fatal(err)
			}
			result := delayedJSONRequest(srv, tt.method, tt.path, tt.body, tt.cookie)
			waitForBlockedMutation(t, pool, result)
			if _, err := tx.Exec(context.Background(), "update sessions set ended_at = now() where id = $1", id); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(context.Background()); err != nil {
				t.Fatal(err)
			}
			if status := <-result; status != http.StatusConflict {
				t.Fatalf("status = %d, want 409", status)
			}
			tt.assertNone(t)
		})
	}
}

func TestStandupEntryCannotFinishAfterDelayedClosure(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	_, member, _, id, _ := standupSetup(t, srv, "Delayed Standup Closure Space")

	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), "select id from sessions where id = $1 for update", id); err != nil {
		t.Fatal(err)
	}
	result := delayedJSONRequest(srv, http.MethodPut, "/api/sessions/"+id+"/actions/standup", `{"today":"Too late"}`, member)
	waitForBlockedMutation(t, pool, result)
	if _, err := tx.Exec(context.Background(), "update sessions set ended_at = now() where id = $1", id); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if status := <-result; status != http.StatusConflict {
		t.Fatalf("status = %d, want 409", status)
	}

	var entryCount int
	if err := pool.QueryRow(context.Background(), "select count(*) from standup_entries where session_id = $1", id).Scan(&entryCount); err != nil {
		t.Fatal(err)
	}
	if entryCount != 0 {
		t.Fatalf("entries = %d, want 0", entryCount)
	}
}
