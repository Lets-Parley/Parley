package api

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func logThrough(t *testing.T, level slog.Level, trustedCIDRs []string, remote string, headers map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: level}))
	h := trustedProxyHeaders(prefixes(trustedCIDRs...), log)(keyHandler())
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remote
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return buf.String()
}

func TestClientAddressLogsTheTrustDecisionAtDebug(t *testing.T) {
	out := logThrough(t, slog.LevelDebug, []string{"10.0.0.0/8"}, "10.0.0.8:443", map[string]string{
		"X-Forwarded-For": "198.51.100.7, 10.0.0.9",
	})
	for _, want := range []string{"10.0.0.8:443", "198.51.100.7", "10.0.0.9", `"peer_trusted":true`, `"resolved":"198.51.100.7"`} {
		if !strings.Contains(out, want) {
			t.Errorf("debug log %s is missing %q", out, want)
		}
	}
}

// The untrusted-peer branch returns early, before any rewrite. It is also
// exactly the case an operator debugging a misconfigured proxy needs to see,
// so a log placed only on the success path would miss the one that matters.
func TestClientAddressLogsAnUntrustedPeer(t *testing.T) {
	out := logThrough(t, slog.LevelDebug, []string{"10.0.0.0/8"}, "203.0.113.9:8443", map[string]string{
		"X-Forwarded-For": "198.51.100.7",
	})
	if !strings.Contains(out, `"peer_trusted":false`) {
		t.Errorf("debug log %s does not report the untrusted peer", out)
	}
	for _, want := range []string{"203.0.113.9:8443", `"resolved":"203.0.113.9:8443"`} {
		if !strings.Contains(out, want) {
			t.Errorf("debug log %s is missing %q", out, want)
		}
	}
}

func TestClientAddressLogsNothingAtInfo(t *testing.T) {
	out := logThrough(t, slog.LevelInfo, []string{"10.0.0.0/8"}, "10.0.0.8:443", map[string]string{
		"X-Forwarded-For": "198.51.100.7",
	})
	if out != "" {
		t.Errorf("client-address logging is not opt-in: %s", out)
	}
}

// The logged fields are an exhaustive allow-list: the socket peer, the
// forwarded chain, and the resolved address. Nothing that carries a credential
// may ever reach the log, at any level.
func TestClientAddressNeverLogsCredentials(t *testing.T) {
	out := logThrough(t, slog.LevelDebug, []string{"10.0.0.0/8"}, "10.0.0.8:443", map[string]string{
		"X-Forwarded-For": "198.51.100.7",
		"Cookie":          "parley_session=super-secret-session-value",
		"Authorization":   "Bearer super-secret-bearer-token",
	})
	for _, forbidden := range []string{
		"super-secret-session-value",
		"super-secret-bearer-token",
		"parley_session",
		"Authorization",
		"Cookie",
	} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("debug log leaked %q: %s", forbidden, out)
		}
	}
}
