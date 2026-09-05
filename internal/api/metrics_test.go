package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func metricsServer(t *testing.T) *httptest.Server {
	t.Helper()
	return testServerWith(t, testPool(t), Options{
		AllowedOrigin:  testOrigin,
		MetricsEnabled: true,
	})
}

func getMetrics(t *testing.T, srv *httptest.Server) (int, string) {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(body)
}

func metricLine(body, name, value string) bool {
	want := name + " " + value
	for _, line := range strings.Split(body, "\n") {
		if line == want {
			return true
		}
	}
	return false
}

func TestMetricsOffByDefaultIsNotAPrometheusExposition(t *testing.T) {
	srv := testServer(t)
	status, body := getMetrics(t, srv)
	if status == http.StatusOK && strings.Contains(body, "# HELP") {
		t.Fatalf("GET /metrics with metrics off returned a Prometheus exposition (status %d)", status)
	}
}

func TestMetricsEnabledExposesRuntimeAndParley(t *testing.T) {
	srv := metricsServer(t)
	status, body := getMetrics(t, srv)
	if status != http.StatusOK {
		t.Fatalf("GET /metrics: status %d, want 200", status)
	}
	for _, name := range []string{
		"parley_ws_connections",
		"parley_listener_reconnects_total",
		"parley_passcode_throttled_total",
		"parley_identity_throttled_total",
		"go_goroutines",
		"parley_pgxpool_total_conns",
	} {
		if !strings.Contains(body, name) {
			t.Errorf("GET /metrics is missing %q", name)
		}
	}
}

func TestMetricsDoesNotRequireASessionCookie(t *testing.T) {
	srv := metricsServer(t)
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/metrics", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unauthenticated GET /metrics: status %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(string(body), "parley_ws_connections") {
		t.Fatal("unauthenticated GET /metrics did not return the exposition")
	}
}

func TestMetricsWebSocketConnections(t *testing.T) {
	srv := metricsServer(t)
	fac, member, id := setupSession(t, srv, "Metrics WS")
	one := joinRoom(t, srv, id, fac)
	two := joinRoom(t, srv, id, member)

	if !awaitMetric(t, srv, "parley_ws_connections", "2") {
		_, body := getMetrics(t, srv)
		t.Fatalf("after two sockets, want parley_ws_connections 2, got:\n%s", body)
	}

	one.Close()
	if !awaitMetric(t, srv, "parley_ws_connections", "1") {
		_, body := getMetrics(t, srv)
		t.Fatalf("after closing one socket, want parley_ws_connections 1, got:\n%s", body)
	}
	_ = two
}

func TestMetricsPasscodeThrottle(t *testing.T) {
	srv := metricsServer(t)
	owner := signup(t, srv, "Owner")
	doJSON(t, srv, "POST", "/api/spaces", `{"name":"Metrics Throttle"}`, owner)

	guesser := signup(t, srv, "Guesser")
	var last int
	for range passcodeAttemptLimit + 1 {
		resp, _ := doJSON(t, srv, "POST", "/api/orgs/default/spaces/metrics-throttle/join", `{"passcode":"ZZZZZZ"}`, guesser)
		last = resp.StatusCode
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("guessing was never throttled: last status %d", last)
	}

	_, body := getMetrics(t, srv)
	if !metricLine(body, "parley_passcode_throttled_total", "1") {
		t.Fatalf("after one throttle, want parley_passcode_throttled_total 1, got:\n%s", body)
	}
}

func awaitMetric(t *testing.T, srv *httptest.Server, name, value string) bool {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, body := getMetrics(t, srv)
		if metricLine(body, name, value) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}
