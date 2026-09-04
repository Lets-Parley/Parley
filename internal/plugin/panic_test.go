package plugin

import (
	"context"
	"testing"
	"time"
)

// The retention pass and the outbox and job workers all run on runLoop, so one
// panicking step there is three background goroutines that would otherwise take
// the process down with them.
func TestRunLoopSurvivesAPanickingStep(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := make(chan struct{}, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runLoop(ctx, time.Millisecond, nil, "test loop", func(context.Context) error {
			calls <- struct{}{}
			panic("step exploded")
		})
	}()

	for i := 0; i < 2; i++ {
		select {
		case <-calls:
		case <-time.After(2 * time.Second):
			t.Fatalf("loop stopped after %d passes", i)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("loop did not stop")
	}
}
