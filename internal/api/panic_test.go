package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// healthzStillAnswers is the point of all of this: whatever a background
// goroutine did to itself, the process is still serving.
func healthzStillAnswers(t *testing.T, srv *httptest.Server) {
	t.Helper()
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz after a background panic: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /healthz: got %d, want 200", resp.StatusCode)
	}
}

// A nil pool is enough here: Router answers /healthz without a database, and
// these tests drive the background loops directly.
func panicTestServer(t *testing.T) (*app, *httptest.Server) {
	t.Helper()
	h := Router(nil, Options{})
	t.Cleanup(h.Shutdown)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &app{}, srv
}

func TestPanicInTheListenerLoopKeepsTheProcessServing(t *testing.T) {
	a, srv := panicTestServer(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := make(chan struct{}, 4)
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.listenLoop(ctx, func(context.Context) error {
			calls <- struct{}{}
			panic("listener exploded")
		})
	}()

	select {
	case <-calls:
	case <-time.After(2 * time.Second):
		t.Fatal("listener never ran")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(35 * time.Second):
		t.Fatal("listener loop did not stop")
	}

	// A panicking listener is a dropped listener: the replica must stop
	// claiming it can hear the others.
	if a.listenerHealthy() {
		t.Fatal("listener reported healthy after it panicked")
	}
	healthzStillAnswers(t, srv)
}

func TestListenerLoopStillStopsOnAnOrdinaryError(t *testing.T) {
	a, _ := panicTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.listenLoop(ctx, func(context.Context) error {
			calls++
			cancel()
			return errors.New("dropped")
		})
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("listener loop did not stop after an error")
	}
	if calls == 0 {
		t.Fatal("listener step never ran")
	}
}

func TestPanicInThePresenceSweeperKeepsTheProcessServing(t *testing.T) {
	a, srv := panicTestServer(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := make(chan struct{}, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.sweepLoop(ctx, time.Millisecond, func(context.Context) error {
			calls <- struct{}{}
			panic("sweeper exploded")
		})
	}()

	// Twice: the sweeper must keep sweeping after a panic, not merely survive
	// the first one.
	for i := 0; i < 2; i++ {
		select {
		case <-calls:
		case <-time.After(2 * time.Second):
			t.Fatalf("sweeper stopped after %d passes", i)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("sweeper did not stop")
	}
	healthzStillAnswers(t, srv)
}
