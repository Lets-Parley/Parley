package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
)

func webhookURL(slug string) string {
	return "/api/orgs/default/spaces/" + slug + "/standup-webhook"
}

// testWebhookKey is a base64 32-byte key, used only here.
const testWebhookKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

func webhookTestServer(t *testing.T) (*http.Cookie, *http.Cookie, string, func(method, body string, c *http.Cookie) (*http.Response, map[string]any)) {
	t.Helper()
	pool := testPool(t)
	cipher, err := plugin.NewCipher(testWebhookKey)
	if err != nil {
		t.Fatal(err)
	}
	srv := testServerWith(t, pool, Options{
		AllowedOrigin:       "http://example.test",
		Plugins:             &plugin.Store{Pool: pool, Cipher: cipher},
		StandupWebhookHosts: []string{"hooks.example.com", "*.hooks.example.org"},
	})
	owner, member, slug := deckSpace(t, srv)
	return owner, member, slug, func(method, body string, c *http.Cookie) (*http.Response, map[string]any) {
		return doJSON(t, srv, method, webhookURL(slug), body, c)
	}
}

func TestOwnerConfiguresTheStandupWebhookAndSeesTheSecretOnce(t *testing.T) {
	owner, _, _, do := webhookTestServer(t)
	resp, body := do(http.MethodPut, `{"url":"https://hooks.example.com/in"}`, owner)
	secret, _ := body["secret"].(string)
	if resp.StatusCode != http.StatusOK || len(secret) < 32 || body["url"] != "https://hooks.example.com/in" {
		t.Fatalf("put: got %d %v", resp.StatusCode, body)
	}
	resp, body = do(http.MethodGet, "", owner)
	if resp.StatusCode != http.StatusOK || body["url"] != "https://hooks.example.com/in" {
		t.Fatalf("get: got %d %v", resp.StatusCode, body)
	}
	if _, ok := body["secret"]; ok {
		t.Fatalf("the secret was shown a second time: %v", body)
	}
	if resp, _ := do(http.MethodDelete, "", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: got %d", resp.StatusCode)
	}
	if resp, body := do(http.MethodGet, "", owner); resp.StatusCode != http.StatusOK || body["url"] != nil {
		t.Fatalf("after delete: got %d %v", resp.StatusCode, body)
	}
}

func TestOnlyTheSpaceOwnerConfiguresTheStandupWebhook(t *testing.T) {
	_, member, _, do := webhookTestServer(t)
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		if resp, body := do(m, `{"url":"https://hooks.example.com/in"}`, member); resp.StatusCode != http.StatusForbidden {
			t.Errorf("member %s: got %d %v, want 403", m, resp.StatusCode, body)
		}
	}
}

func TestStandupWebhookRefusesAHostOffTheAllowlist(t *testing.T) {
	owner, _, _, do := webhookTestServer(t)
	for _, u := range []string{
		"https://evil.example.net/in",
		"https://hooks.example.com.evil.net/in",
		"http://hooks.example.com/in",          // not https
		"https://10.0.0.5/in",                  // private address
		"https://127.0.0.1/in",                 // loopback
		"https://user:pw@hooks.example.com/in", // credentials in the URL
		"not a url",
	} {
		if resp, body := do(http.MethodPut, `{"url":"`+u+`"}`, owner); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: got %d %v, want 400", u, resp.StatusCode, body)
		}
	}
	if resp, body := do(http.MethodPut, `{"url":"https://a.hooks.example.org/x"}`, owner); resp.StatusCode != http.StatusOK {
		t.Fatalf("wildcard subdomain: got %d %v", resp.StatusCode, body)
	}
}

// Delivery goes through the plugin fetch guard, so even an operator who
// allowlists an address cannot point a webhook at the internal network.
func TestWebhookDeliveryRefusesAPrivateAddress(t *testing.T) {
	send := guardedWebhookSend(&plugin.Fetcher{}, []string{"127.0.0.1", "10.0.0.5"})
	for _, u := range []string{"https://127.0.0.1:1/in", "https://10.0.0.5/in"} {
		_, err := send(context.Background(), u, map[string]string{}, []byte(`{}`))
		if !errors.Is(err, plugin.ErrFetchBlockedAddress) {
			t.Errorf("%s: got %v, want ErrFetchBlockedAddress", u, err)
		}
	}
	if _, err := send(context.Background(), "https://elsewhere.example/in", nil, nil); !errors.Is(err, plugin.ErrFetchHostNotAllowed) || !strings.Contains(err.Error(), "elsewhere") {
		t.Errorf("off-list host: got %v", err)
	}
}
