package api

import (
	"net/http"
	"testing"
)

func TestPublicationRoutesRequireFacilitatorAndExplainDisabledStorage(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "Publication routes")
	root := "/api/sessions/" + id + "/publication"
	resp, body := doJSON(t, srv, "GET", root+"/connection", "", fac)
	if resp.StatusCode != 200 || body["available"] != false {
		t.Fatalf("missing encrypted storage status: %d %v", resp.StatusCode, body)
	}
	for _, path := range []string{"/connection", "/preview", "/approve", "/reviews/00000000-0000-0000-0000-000000000001/run", "/reviews/00000000-0000-0000-0000-000000000001/verify"} {
		verb := http.MethodPost
		if path == "/connection" {
			verb = http.MethodGet
		}
		resp, _ = doJSON(t, srv, verb, root+path, `{}`, member)
		if resp.StatusCode != 403 {
			t.Fatalf("member reached %s: %d", path, resp.StatusCode)
		}
	}
	resp, _ = doJSON(t, srv, "POST", root+"/preview", `{}`, fac)
	if resp.StatusCode != 503 {
		t.Fatalf("preview without key: %d", resp.StatusCode)
	}
}
