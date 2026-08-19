package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	srv := testServer(t)

	want := map[string]string{
		"Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Referrer-Policy":         "strict-origin-when-cross-origin",
	}

	for _, path := range []string{"/healthz", "/api/me", "/no-such-page"} {
		t.Run(path, func(t *testing.T) {
			req, err := http.NewRequest("GET", srv.URL+path, nil)
			if err != nil {
				t.Fatalf("build request: %v", err)
			}
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatalf("request %s: %v", path, err)
			}
			resp.Body.Close()
			for header, value := range want {
				if got := resp.Header.Get(header); got != value {
					t.Fatalf("%s: %s header: got %q, want %q", path, header, got, value)
				}
			}
		})
	}
}

func TestCrossSiteGuardAllowsAbsentOrigin(t *testing.T) {
	srv := testServer(t)

	req, err := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"Ada"}`))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden {
		t.Fatalf("a non-browser client with no Origin header was rejected: got %d", resp.StatusCode)
	}
}

func TestCrossSiteGuardAllowsSameSiteFetch(t *testing.T) {
	srv := testServer(t)

	tests := []struct {
		secFetchSite string
		wantAllowed  bool
	}{
		{secFetchSite: "same-site", wantAllowed: true},
		{secFetchSite: "same-origin", wantAllowed: true},
		{secFetchSite: "cross-site", wantAllowed: false},
	}

	for _, tc := range tests {
		t.Run(tc.secFetchSite, func(t *testing.T) {
			req, err := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`{"name":"Ada"}`))
			if err != nil {
				t.Fatalf("build request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Sec-Fetch-Site", tc.secFetchSite)
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatalf("request: %v", err)
			}
			resp.Body.Close()
			forbidden := resp.StatusCode == http.StatusForbidden
			if tc.wantAllowed && forbidden {
				t.Fatalf("Sec-Fetch-Site %q: got %d, want the request to pass the guard", tc.secFetchSite, resp.StatusCode)
			}
			if !tc.wantAllowed && !forbidden {
				t.Fatalf("Sec-Fetch-Site %q: got %d, want %d", tc.secFetchSite, resp.StatusCode, http.StatusForbidden)
			}
		})
	}
}

func TestRequireJSONBodyRejectsWrongContentType(t *testing.T) {
	srv := testServer(t)

	req, err := http.NewRequest("POST", srv.URL+"/api/me", strings.NewReader(`name=Ada`))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "text/plain")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain body: got %d, want %d", resp.StatusCode, http.StatusUnsupportedMediaType)
	}
}
