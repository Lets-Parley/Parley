package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These pages were left describing a product the self-hosting epic already
// changed. Each subtest names the claim an operator would still read on main
// and requires the replacement that now holds.

func TestKubernetesDocsRequireVerifyingSSLMode(t *testing.T) {
	body := readDocs(t, "operations/kubernetes.mdx")
	if strings.Contains(body, "if your Postgres requires TLS") {
		t.Error("kubernetes.mdx still treats sslmode as optional for TLS Postgres")
	}
	for _, want := range []string{
		"DATABASE_ALLOW_PLAINTEXT",
		"verify-full",
		"disable",
		"allow",
		"prefer",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("kubernetes.mdx does not mention %q — CheckTLS refuses absent/disable/allow/prefer unless DATABASE_ALLOW_PLAINTEXT is set", want)
		}
	}
	if strings.Contains(body, "?sslmode=require") {
		t.Error("kubernetes.mdx still shows sslmode=require as the install example; a verifying mode is required")
	}
}

func TestKnownLimitationsNoLongerDeniesMetrics(t *testing.T) {
	body := readDocs(t, "known-limitations.mdx")
	if strings.Contains(body, "There is no <code>/metrics</code>") {
		t.Error("known-limitations.mdx still says there is no /metrics")
	}
	for _, want := range []string{
		"METRICS_ENABLED",
		"unauthenticated",
		"/operations/observability/",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("known-limitations.mdx does not mention %q", want)
		}
	}
}

func TestReviewPackMatchesBuiltMetricsAndTokenSweep(t *testing.T) {
	body := readDocs(t, "security/review-pack.mdx")
	if strings.Contains(body, `{ name: "Metrics and tracing", status: "not-built"`) {
		t.Error("review-pack.mdx still marks Metrics and tracing as not-built")
	}
	if strings.Contains(body, "Token authorization expires, but its row remains") {
		t.Error("review-pack.mdx still claims expired session token rows remain")
	}
	if !strings.Contains(body, "hourly") || !strings.Contains(body, "session_tokens") {
		t.Error("review-pack.mdx does not describe the hourly session_tokens sweep")
	}
}

func TestDeploymentDocsDoNotClaimHardeningParity(t *testing.T) {
	body := readDocs(t, "operations/deployment.mdx")
	if strings.Contains(body, "carries the same container-hardening keys") {
		t.Error("deployment.mdx still claims Compose and Kubernetes carry the same hardening")
	}
	for _, want := range []string{
		"seccompProfile",
		"runAsNonRoot",
		"no-new-privileges",
		"log rotation",
		"Kubernetes-only",
		"Compose-only",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("deployment.mdx does not mention %q in the per-key hardening map", want)
		}
	}
}

func TestObservabilityListsSessionSweeper(t *testing.T) {
	body := readDocs(t, "operations/observability.mdx")
	if !strings.Contains(body, "sessionSweeper") {
		t.Error("observability.mdx does not list sessionSweeper among background workers")
	}
	if !strings.Contains(body, "session token sweep failed") {
		t.Error("observability.mdx does not name the stuck-sweeper log line")
	}
}

func readDocs(t *testing.T, rel string) string {
	t.Helper()
	path := filepath.Clean(filepath.Join("..", "..", "site", "src", "content", "docs", rel))
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(b)
}
