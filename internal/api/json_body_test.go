package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A proxy that forwards a body-less POST without Content-Length (Cloudflare
// Tunnel does) hands Go ContentLength -1. That is still an empty body, so it
// must pass exactly as a known-empty one does; a real body of unknown length
// must still need JSON, and must reach the handler intact.
func TestRequireJSONBodyUnknownLength(t *testing.T) {
	var got string
	h := requireJSONBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	cases := []struct {
		name, body, ct string
		want           int
	}{
		{"empty, no type", "", "", http.StatusNoContent},
		{"form body, no type", "a=b", "", http.StatusUnsupportedMediaType},
		{"form body, form type", "a=b", "application/x-www-form-urlencoded", http.StatusUnsupportedMediaType},
		{"json body", `{"a":1}`, "application/json", http.StatusNoContent},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got = ""
			req := httptest.NewRequest(http.MethodPost, "/api/x", io.NopCloser(strings.NewReader(c.body)))
			req.ContentLength = -1
			if c.ct != "" {
				req.Header.Set("Content-Type", c.ct)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("status = %d, want %d", rec.Code, c.want)
			}
			if c.want == http.StatusNoContent && got != c.body {
				t.Fatalf("handler read %q, want %q", got, c.body)
			}
		})
	}
}
