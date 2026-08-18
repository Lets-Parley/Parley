package api

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func clientKeyThrough(next http.Handler, remote string, headers map[string]string) string {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remote
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	next.ServeHTTP(rec, req.WithContext(req.Context()))
	return rec.Header().Get("X-Test-Client-Key")
}

func keyHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test-Client-Key", clientKey(r))
	})
}

func prefixes(values ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(values))
	for i, value := range values {
		out[i] = netip.MustParsePrefix(value)
	}
	return out
}

func TestTrustedProxyHeadersSelectsFirstUntrustedHop(t *testing.T) {
	h := trustedProxyHeaders(prefixes("10.0.0.0/8", "2001:db8:ffff::/48"))(keyHandler())
	got := clientKeyThrough(h, "10.0.0.8:443", map[string]string{
		"X-Forwarded-For": "198.51.100.7, 2001:db8:ffff::4, 10.0.0.9",
	})
	if got != "198.51.100.7" {
		t.Fatalf("client key = %q, want 198.51.100.7", got)
	}
}

func TestTrustedProxyHeadersRejectsUntrustedImmediatePeer(t *testing.T) {
	h := trustedProxyHeaders(prefixes("10.0.0.0/8"))(keyHandler())
	got := clientKeyThrough(h, "203.0.113.9:8443", map[string]string{"X-Forwarded-For": "198.51.100.7"})
	if got != "203.0.113.9" {
		t.Fatalf("client key = %q, want socket peer", got)
	}
}

func TestTrustedProxyHeadersNormalizesAddressesAndPorts(t *testing.T) {
	h := trustedProxyHeaders(prefixes("10.0.0.0/8"))(keyHandler())
	got := clientKeyThrough(h, "[::ffff:10.0.0.8]:443", map[string]string{"X-Forwarded-For": "[2001:db8::7]:9443"})
	if got != "2001:db8::7" {
		t.Fatalf("client key = %q, want normalized IPv6", got)
	}
}

func TestTrustedProxyHeadersNormalizesIPv4MappedCIDRs(t *testing.T) {
	h := trustedProxyHeaders(prefixes("::ffff:10.0.0.0/104"))(keyHandler())
	got := clientKeyThrough(h, "10.1.2.3:443", map[string]string{"X-Forwarded-For": "198.51.100.7"})
	if got != "198.51.100.7" {
		t.Fatalf("client key = %q, want forwarded client through normalized mapped CIDR", got)
	}
}

func TestTrustedProxyHeadersNormalizesIPv6Zone(t *testing.T) {
	h := trustedProxyHeaders(prefixes("fe80::/10"))(keyHandler())
	got := clientKeyThrough(h, "[fe80::1%eth0]:443", map[string]string{"X-Forwarded-For": "2001:db8::7"})
	if got != "2001:db8::7" {
		t.Fatalf("client key = %q, want forwarded client through zoned IPv6 proxy", got)
	}
}

func TestTrustedProxyHeadersIgnoresMalformedChain(t *testing.T) {
	h := trustedProxyHeaders(prefixes("10.0.0.0/8"))(keyHandler())
	got := clientKeyThrough(h, "10.0.0.8:443", map[string]string{"X-Forwarded-For": "198.51.100.7, garbage"})
	if got != "10.0.0.8" {
		t.Fatalf("client key = %q, want socket peer", got)
	}
}

func TestTrustedProxyHeadersIgnoresAlternateHeaders(t *testing.T) {
	h := trustedProxyHeaders(prefixes("10.0.0.0/8"))(keyHandler())
	got := clientKeyThrough(h, "10.0.0.8:443", map[string]string{
		"X-Real-IP":      "198.51.100.7",
		"True-Client-IP": "192.0.2.4",
	})
	if got != "10.0.0.8" {
		t.Fatalf("client key = %q, want socket peer", got)
	}
}

func TestTrustedProxyHeadersRejectsDuplicateFieldLines(t *testing.T) {
	h := trustedProxyHeaders(prefixes("10.0.0.0/8"))(keyHandler())
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.8:443"
	req.Header.Add("X-Forwarded-For", "198.51.100.7")
	req.Header.Add("X-Forwarded-For", "192.0.2.4")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Test-Client-Key"); got != "10.0.0.8" {
		t.Fatalf("client key = %q, want verified socket peer", got)
	}
}
