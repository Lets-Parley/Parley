package site_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func airGappedPage(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Join(filepath.Dir(thisFile), "src/content/docs/operations/air-gapped.mdx")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func fenced(src, lang string) []string {
	open := "```" + lang
	var out []string
	rest := src
	for {
		i := strings.Index(rest, open)
		if i < 0 {
			return out
		}
		rest = rest[i+len(open):]
		rest = strings.TrimPrefix(rest, "\n")
		end := strings.Index(rest, "```")
		if end < 0 {
			return out
		}
		out = append(out, rest[:end])
		rest = rest[end+3:]
	}
}

func firstYAMLContaining(t *testing.T, body, needle string) string {
	t.Helper()
	for _, block := range fenced(body, "yaml") {
		if strings.Contains(block, needle) {
			return block
		}
	}
	t.Fatalf("no ```yaml fence contains %q", needle)
	return ""
}

// TestAirGappedPageCompletesComposeAndOIDCInstalls pins the epic bar for
// operations/air-gapped.mdx: an operator following only that page can install
// from a private registry with a private CA on both the IdP and Postgres legs.
func TestAirGappedPageCompletesComposeAndOIDCInstalls(t *testing.T) {
	body := airGappedPage(t)

	t.Run("compose image is the mirrored digest not ghcr", func(t *testing.T) {
		compose := firstYAMLContaining(t, body, "services:")
		if strings.Contains(compose, "ghcr.io") {
			t.Error("compose still names ghcr.io — retarget image: at the mirrored registry")
		}
		if !strings.Contains(compose, "image: internal-registry.example.com") {
			t.Error("compose image: does not name the mirrored registry")
		}
		if !strings.Contains(compose, "@sha256:") {
			t.Error("compose image is not pinned by digest")
		}
		if !strings.Contains(compose, "depends_on: !reset") {
			t.Error("compose overlay does not reset depends_on — merged up would still start db")
		}
		if !strings.Contains(body, "docker compose -f docker-compose.yml -f air-gapped.yml") {
			t.Error("page never shows docker compose -f docker-compose.yml -f air-gapped.yml")
		}
	})

	t.Run("registry login is shown", func(t *testing.T) {
		if !strings.Contains(body, "docker login") && !strings.Contains(body, "podman login") {
			t.Error("page never shows docker/podman login against the mirrored registry")
		}
	})

	t.Run("helm values file would render", func(t *testing.T) {
		values := firstYAMLContaining(t, body, "existingSecret")
		for _, need := range []string{
			"existingSecret:",
			"baseURL:",
			"extraVolumes:",
			"extraVolumeMounts:",
			"SSL_CERT_FILE",
			"mode: oidc",
			"issuer:",
			"clientID:",
			"publicClient:",
			"digest:",
		} {
			if !strings.Contains(values, need) {
				t.Errorf("helm values fence is missing %q — helm install -f my-values.yaml must be a complete file", need)
			}
		}
	})

	t.Run("idp settings are on both legs", func(t *testing.T) {
		compose := firstYAMLContaining(t, body, "services:")
		for _, need := range []string{"AUTH_MODE", "OIDC_ISSUER", "OIDC_CLIENT_ID"} {
			if !strings.Contains(compose, need) {
				t.Errorf("compose fence is missing %s — following the page never talks to an IdP", need)
			}
		}
		if !strings.Contains(compose, "oidc") {
			t.Error("compose AUTH_MODE is not oidc")
		}
	})

	t.Run("bundled compose db is not sold as verify-full", func(t *testing.T) {
		compose := firstYAMLContaining(t, body, "services:")
		if strings.Contains(compose, "sslmode=verify-full") && (strings.Contains(compose, "@db:") || strings.Contains(compose, "@db/")) {
			t.Error("compose DATABASE_URL uses sslmode=verify-full against the bundled db service, which does not speak TLS")
		}
		if !strings.Contains(body, "cannot satisfy `verify-full`") {
			t.Error("page does not state that the bundled db service cannot satisfy verify-full")
		}
		if !strings.Contains(body, "bundled-plaintext") {
			t.Error("page does not park the bundled db behind a profile so up -d will not start it")
		}
	})

	t.Run("confidential client names oidc-client-secret", func(t *testing.T) {
		if !strings.Contains(body, "--from-literal=oidc-client-secret") {
			t.Error("page never shows kubectl create secret with the chart's oidc-client-secret key")
		}
	})
}
