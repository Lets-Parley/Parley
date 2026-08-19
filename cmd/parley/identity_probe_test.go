package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

type stubWarmer struct {
	issuer string
	err    error
	block  chan struct{}
	warmed chan struct{}
}

func (s *stubWarmer) Issuer() string { return s.issuer }

func (s *stubWarmer) Warm(ctx context.Context) error {
	if s.warmed != nil {
		close(s.warmed)
	}
	if s.block != nil {
		<-s.block
	}
	return s.err
}

func TestIdentityProbeLogsAReachableIssuer(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))

	probeIdentityProvider(context.Background(), log, &stubWarmer{issuer: "https://idp.example.test"})

	out := buf.String()
	if !strings.Contains(out, "https://idp.example.test") {
		t.Errorf("probe log %s does not name the issuer", out)
	}
	if !strings.Contains(out, "reachable") {
		t.Errorf("probe log %s does not report reachability", out)
	}
	// Discovery proves the issuer answers; it says nothing about the client
	// credentials, which only fail at token exchange. The line must not
	// overstate that.
	if strings.Contains(out, `"level":"WARN"`) {
		t.Errorf("a healthy provider logged a warning: %s", out)
	}
}

func TestIdentityProbeLogsAnUnreachableIssuerAsAWarning(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))

	probeIdentityProvider(context.Background(), log, &stubWarmer{
		issuer: "https://idp.example.test",
		err:    errors.New("connection refused"),
	})

	out := buf.String()
	if !strings.Contains(out, `"level":"WARN"`) {
		t.Errorf("an unreachable provider did not warn: %s", out)
	}
	for _, want := range []string{"https://idp.example.test", "connection refused"} {
		if !strings.Contains(out, want) {
			t.Errorf("probe log %s is missing %q", out, want)
		}
	}
}

// The whole point of deferred discovery is that a slow identity provider must
// not delay the listener. A probe that blocked its caller would put that
// coupling straight back.
func TestStartIdentityProbeDoesNotBlockTheCaller(t *testing.T) {
	block := make(chan struct{})
	warmed := make(chan struct{})
	defer close(block)

	log := slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))
	done := make(chan struct{})
	go func() {
		startIdentityProbe(context.Background(), log, &stubWarmer{
			issuer: "https://idp.example.test",
			block:  block,
			warmed: warmed,
		})
		close(done)
	}()

	select {
	case <-warmed:
	case <-time.After(5 * time.Second):
		t.Fatal("the probe never ran")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("startIdentityProbe blocked on a hanging identity provider")
	}
}
