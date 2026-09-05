package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

var securityEventKeys = []string{
	"event", "actor_user_id", "actor_subject", "org", "space",
	"target", "outcome", "client_addr", "request_id",
}

// Hand-written secrets planted on every instrumented request. The log line
// must name the event and must never repeat any of these.
const (
	baitCookie   = "never-log-this-cookie-value"
	baitPasscode = "NEVERLOG"
	baitStory    = "never-log-this-story-body"
)

func requestIDThrough(t *testing.T, opts Options, remote, inbound string) string {
	t.Helper()
	h := Router(nil, opts)
	t.Cleanup(h.Shutdown)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.RemoteAddr = remote
	if inbound != "" {
		req.Header.Set("X-Request-Id", inbound)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Header().Get("X-Request-Id")
}

func TestRequestIDIsEchoed(t *testing.T) {
	got := requestIDThrough(t, Options{}, "192.0.2.1:1234", "")
	if got == "" {
		t.Fatal("X-Request-Id was not echoed")
	}
}

func TestRequestIDHonoursInboundFromATrustedProxy(t *testing.T) {
	const inbound = "proxy-generated-request-id-001"
	got := requestIDThrough(t, Options{
		TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")},
	}, "192.0.2.1:443", inbound)
	if got != inbound {
		t.Fatalf("X-Request-Id = %q, want the inbound id from the trusted proxy", got)
	}
}

func TestRequestIDIgnoresInboundFromAnUntrustedPeer(t *testing.T) {
	const inbound = "attacker-supplied-request-id"
	got := requestIDThrough(t, Options{
		TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")},
	}, "192.0.2.1:443", inbound)
	if got == "" {
		t.Fatal("X-Request-Id was not echoed")
	}
	if got == inbound {
		t.Fatal("an untrusted peer's X-Request-Id was honoured")
	}
}

func TestRequestIDIgnoresInboundWhenNoTrustedProxiesAreConfigured(t *testing.T) {
	const inbound = "attacker-supplied-request-id"
	got := requestIDThrough(t, Options{}, "192.0.2.1:443", inbound)
	if got == "" {
		t.Fatal("X-Request-Id was not echoed")
	}
	if got == inbound {
		t.Fatal("an inbound X-Request-Id was honoured with no trusted proxies")
	}
}

func TestRequestIDRejectsAHostileInboundId(t *testing.T) {
	opts := Options{TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}}
	for _, inbound := range []string{
		"id-with-a-newline\ninjected",
		"id-with-a-cr\rinjected",
		strings.Repeat("a", 129),
		"id-with-a-tab\tinjected",
	} {
		got := requestIDThrough(t, opts, "192.0.2.1:443", inbound)
		if got == "" {
			t.Errorf("hostile inbound %q: X-Request-Id was not echoed", inbound)
		}
		if got == inbound {
			t.Errorf("hostile inbound %q was honoured", inbound)
		}
		if strings.ContainsAny(got, "\n\r\t") {
			t.Errorf("echoed id %q still carries a control character", got)
		}
		if len(got) > 128 {
			t.Errorf("echoed id is %d bytes, want at most 128", len(got))
		}
	}
}

func TestRequestIDUsesThePostProxyClientAddressOnSecurityEvents(t *testing.T) {
	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	pool := testPool(t)
	srv := testServerWith(t, pool, Options{
		AllowedOrigin:     testOrigin,
		TrustProxyHeaders: true,
		TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")},
	})

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/me", strings.NewReader(`{"name":"Ada"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "198.51.100.77")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/me: got %d, want 201", resp.StatusCode)
	}

	line := securityEventLine(t, buf.String(), "auth.signin")
	if line["client_addr"] != "198.51.100.77" {
		t.Fatalf("client_addr = %v, want the forwarded client, not the socket", line["client_addr"])
	}
}

func TestSecurityEventsOmitSecretsAndCoverTheSchema(t *testing.T) {
	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: &plugin.Store{Pool: pool}})

	adaRes := secDo(t, srv, http.MethodPost, "/api/me", `{"name":"Ada"}`, nil)
	if adaRes.status != http.StatusCreated {
		t.Fatalf("signup Ada: got %d (%s)", adaRes.status, adaRes.body)
	}
	ada, adaID := adaRes.cookie, adaRes.json["id"].(string)
	melRes := secDo(t, srv, http.MethodPost, "/api/me", `{"name":"Mel"}`, nil)
	if melRes.status != http.StatusCreated {
		t.Fatalf("signup Mel: got %d (%s)", melRes.status, melRes.body)
	}
	mel, melID := melRes.cookie, melRes.json["id"].(string)

	created := secDo(t, srv, http.MethodPost, "/api/spaces", `{"name":"Audit Room"}`, ada)
	if created.status != http.StatusCreated {
		t.Fatalf("create space: got %d (%s)", created.status, created.body)
	}
	slug := created.json["slug"].(string)
	code := created.json["passcode"].(string)
	if code == "" {
		t.Fatal("create space returned no passcode")
	}

	if got := secDo(t, srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/join", `{"passcode":"`+code+`"}`, mel); got.status != http.StatusNoContent {
		t.Fatalf("join: got %d (%s)", got.status, got.body)
	}

	rotated := secDo(t, srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/passcode", `{"open":false}`, ada)
	if rotated.status != http.StatusOK {
		t.Fatalf("rotate passcode: got %d (%s)", rotated.status, rotated.body)
	}

	opened := secDo(t, srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/passcode", `{"open":true}`, ada)
	if opened.status != http.StatusOK {
		t.Fatalf("remove passcode: got %d (%s)", opened.status, opened.body)
	}

	if got := secDo(t, srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/members/"+melID+"/role", `{"role":"owner"}`, ada); got.status != http.StatusNoContent {
		t.Fatalf("set role: got %d (%s)", got.status, got.body)
	}

	sess := secDo(t, srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/sessions", `{"kind":"poker","title":"Sprint"}`, ada)
	if sess.status != http.StatusCreated {
		t.Fatalf("create session: got %d (%s)", sess.status, sess.body)
	}
	sessionID := sess.json["id"].(string)

	minted := secDo(t, srv, http.MethodPost, "/api/sessions/"+sessionID+"/links", `{}`, ada)
	if minted.status != http.StatusCreated {
		t.Fatalf("mint link: got %d (%s)", minted.status, minted.body)
	}
	linkID := minted.json["id"].(string)
	linkToken, _ := minted.json["token"].(string)
	if linkToken == "" {
		t.Fatal("mint link returned no token")
	}
	if got := secDo(t, srv, http.MethodDelete, "/api/sessions/"+sessionID+"/links/"+linkID, "", ada); got.status != http.StatusNoContent {
		t.Fatalf("revoke link: got %d (%s)", got.status, got.body)
	}

	if got := secDo(t, srv, http.MethodDelete, "/api/orgs/default/spaces/"+slug+"/members/"+melID, "", ada); got.status != http.StatusNoContent {
		t.Fatalf("remove member: got %d (%s)", got.status, got.body)
	}

	makeOrgAdmin(t, pool, adaID)
	if got := secDo(t, srv, http.MethodPost, "/api/orgs/default/admin/plugins/themes", `{"name":"Pack","version":"1.0.0"}`, ada); got.status != http.StatusNoContent {
		t.Fatalf("theme install audit: got %d (%s)", got.status, got.body)
	}
	if got := secDo(t, srv, http.MethodDelete, "/api/orgs/default/admin/plugins/themes", "", ada); got.status != http.StatusNoContent {
		t.Fatalf("theme reset audit: got %d (%s)", got.status, got.body)
	}

	if got := secDo(t, srv, http.MethodDelete, "/api/orgs/default/spaces/"+slug, "", ada); got.status != http.StatusNoContent {
		t.Fatalf("delete space: got %d (%s)", got.status, got.body)
	}

	if got := secDo(t, srv, http.MethodDelete, "/api/me", "", ada); got.status != http.StatusNoContent {
		t.Fatalf("sign-out: got %d (%s)", got.status, got.body)
	}

	logs := buf.String()
	for _, event := range []string{
		"auth.signin",
		"auth.signout",
		"space.create",
		"space.delete",
		"space.passcode.rotate",
		"space.passcode.remove",
		"space.member.add",
		"space.member.remove",
		"space.member.role",
		"link.mint",
		"link.revoke",
		"theme.install",
		"theme.reset",
	} {
		line := securityEventLine(t, logs, event)
		assertSecurityEventSchema(t, event, line)
		if line["outcome"] != "ok" {
			t.Errorf("%s: outcome = %v, want ok", event, line["outcome"])
		}
		if line["actor_subject"] != "open" {
			t.Errorf("%s: actor_subject = %v, want open", event, line["actor_subject"])
		}
	}

	assertSecurityEventOmitsSecrets(t, logs, ada.Value, code, linkToken)
}

func TestOIDCSignInLogsTheProviderSubject(t *testing.T) {
	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	idp := newFakeIdP(t)
	idp.subject = "oidc-subject-42"
	srv := oidcServer(t, idp)
	signInOIDCWithBait(t, srv, idp)

	line := securityEventLine(t, buf.String(), "auth.signin")
	if line["actor_subject"] != "oidc-subject-42" {
		t.Fatalf("actor_subject = %v, want oidc-subject-42", line["actor_subject"])
	}
	assertSecurityEventSchema(t, "auth.signin", line)
	assertSecurityEventOmitsSecrets(t, buf.String())
}

func TestOIDCLaterRequestLogsTheFederatedSubject(t *testing.T) {
	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	idp := newFakeIdP(t)
	idp.subject = "idp-sub"
	srv, pool := oidcServerPool(t, idp)
	cookie := signInOIDCWithBait(t, srv, idp)
	if _, err := pool.Exec(context.Background(),
		"insert into org_members (org_id, user_id, role) select id, $1, $2 from orgs where slug = $3",
		userIDOf(t, srv, cookie), store.OrgRoleMember, store.DefaultOrgSlug); err != nil {
		t.Fatal(err)
	}

	created := secDo(t, srv, http.MethodPost, "/api/spaces", `{"name":"IdP Room"}`, cookie)
	if created.status != http.StatusCreated {
		t.Fatalf("create space: got %d (%s)", created.status, created.body)
	}

	line := securityEventLine(t, buf.String(), "space.create")
	if line["actor_subject"] != "idp-sub" {
		t.Fatalf("space.create actor_subject = %v, want idp-sub via AuditSubject, not the callback override", line["actor_subject"])
	}
}

func TestSignOutEmitsASecurityEventOnlyWhenASessionIsDeleted(t *testing.T) {
	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	srv := testServer(t)

	if got := secDo(t, srv, http.MethodDelete, "/api/me", "", nil); got.status != http.StatusNoContent {
		t.Fatalf("unauthenticated sign-out: got %d (%s)", got.status, got.body)
	}
	if hasSecurityEvent(buf.String(), "auth.signout") {
		t.Fatalf("unauthenticated DELETE /api/me emitted a security-event line:\n%s", buf.String())
	}

	ada, adaID := signupWithID(t, srv, "Ada")
	if got := secDo(t, srv, http.MethodDelete, "/api/me", "", ada); got.status != http.StatusNoContent {
		t.Fatalf("authenticated sign-out: got %d (%s)", got.status, got.body)
	}
	line := securityEventLine(t, buf.String(), "auth.signout")
	if line["actor_user_id"] != adaID {
		t.Errorf("actor_user_id = %v, want %s", line["actor_user_id"], adaID)
	}
}

func TestGuestSignOutLogsGuestSubject(t *testing.T) {
	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	srv := testServer(t)
	_, _, guest := mintAndRedeem(t, srv, "Guest Audit")
	if got := secDo(t, srv, http.MethodDelete, "/api/me", "", guest); got.status != http.StatusNoContent {
		t.Fatalf("guest sign-out: got %d (%s)", got.status, got.body)
	}
	line := securityEventLine(t, buf.String(), "auth.signout")
	if line["actor_subject"] != "guest" {
		t.Fatalf("actor_subject = %v, want guest", line["actor_subject"])
	}
}

func TestCustodyAuditWritesASecurityEvent(t *testing.T) {
	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	const postProxyClient = "203.0.113.9"
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{
		AllowedOrigin:     testOrigin,
		TrustProxyHeaders: true,
		TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")},
	})
	admin, adminID := signupWithID(t, srv, "Admin")
	makeOrgAdmin(t, pool, adminID)
	slug, _, _, _ := privateSpace(t, srv)
	if _, err := pool.Exec(context.Background(),
		"delete from members m using spaces sp where sp.id = m.space_id and sp.slug = $1", slug); err != nil {
		t.Fatal(err)
	}

	claim := secDoForwarded(t, srv, http.MethodPost, "/api/orgs/"+store.DefaultOrgSlug+"/admin/spaces/"+slug+"/claim", "", admin, postProxyClient)
	if claim.status != http.StatusNoContent {
		t.Fatalf("claim: got %d (%s)", claim.status, claim.body)
	}

	line := securityEventLine(t, buf.String(), "space.claim")
	if line["actor_user_id"] != adminID {
		t.Errorf("actor_user_id = %v, want %s", line["actor_user_id"], adminID)
	}
	if line["space"] != slug {
		t.Errorf("space = %v, want %s", line["space"], slug)
	}
	if line["outcome"] != "ok" {
		t.Errorf("outcome = %v, want ok", line["outcome"])
	}
	if line["client_addr"] != postProxyClient {
		t.Errorf("client_addr = %v, want %s", line["client_addr"], postProxyClient)
	}
	if rid, _ := line["request_id"].(string); rid == "" {
		t.Error("request_id is empty")
	}
	assertSecurityEventSchema(t, "space.claim", line)
	assertSecurityEventOmitsSecrets(t, buf.String())
}

type secResult struct {
	status int
	body   string
	json   map[string]any
	cookie *http.Cookie
}

func secDo(t *testing.T, srv *httptest.Server, method, path, body string, cookie *http.Cookie) secResult {
	t.Helper()
	return secDoForwarded(t, srv, method, path, body, cookie, "")
}

func secDoForwarded(t *testing.T, srv *httptest.Server, method, path, body string, cookie *http.Cookie, forwardedFor string) secResult {
	t.Helper()
	payload := body
	bait := `"bait_passcode":"` + baitPasscode + `","title":"` + baitStory + `"`
	switch {
	case payload == "":
		payload = `{` + bait + `}`
	case strings.HasPrefix(payload, "{"):
		payload = strings.TrimSuffix(payload, "}") + `,` + bait + `}`
	}
	req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	req.AddCookie(&http.Cookie{Name: "bait", Value: baitCookie})
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	out := secResult{status: resp.StatusCode, body: string(raw)}
	json.Unmarshal(raw, &out.json)
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			out.cookie = c
		}
	}
	return out
}

func signInOIDCWithBait(t *testing.T, srv *httptest.Server, idp *fakeIdP) *http.Cookie {
	t.Helper()
	authURL, flow := startSignin(t, srv, "")
	idp.nonce = authURL.Query().Get("nonce")
	payload := `{"bait_passcode":"` + baitPasscode + `","title":"` + baitStory + `"}`
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/auth/callback?code=abc&state="+url.QueryEscape(authURL.Query().Get("state")), strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(flow)
	req.AddCookie(&http.Cookie{Name: "bait", Value: baitCookie})
	resp, err := noRedirect().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return sessionCookieOf(t, resp)
}

func assertSecurityEventSchema(t *testing.T, event string, line map[string]any) {
	t.Helper()
	for _, key := range securityEventKeys {
		if _, ok := line[key]; !ok {
			t.Errorf("%s: missing field %q in %v", event, key, line)
		}
	}
}

func assertSecurityEventOmitsSecrets(t *testing.T, logs string, extras ...string) {
	t.Helper()
	secrets := append([]string{baitCookie, baitPasscode, baitStory}, extras...)
	for _, secret := range secrets {
		if secret != "" && strings.Contains(logs, secret) {
			t.Errorf("security-event log leaked %q:\n%s", secret, logs)
		}
	}
}

func hasSecurityEvent(logs, event string) bool {
	for _, raw := range strings.Split(logs, "\n") {
		if raw == "" {
			continue
		}
		var line map[string]any
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			continue
		}
		if line["msg"] == "security event" && line["event"] == event {
			return true
		}
	}
	return false
}

func securityEventLine(t *testing.T, logs, event string) map[string]any {
	t.Helper()
	for _, raw := range strings.Split(logs, "\n") {
		if raw == "" {
			continue
		}
		var line map[string]any
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			continue
		}
		if line["msg"] == "security event" && line["event"] == event {
			return line
		}
	}
	t.Fatalf("no security-event line for %q in:\n%s", event, logs)
	return nil
}
