package api

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

const (
	jiraKey         = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
	jiraPreviousKey = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA="
	jiraSecret      = "jira-client-secret-canary-9f3a"
	jiraClientID    = "jira-client-id-canary-2b7c"
	jiraAccessToken = "jira-access-token-canary-88e1"
	jiraIssueBody   = "jira-issue-body-canary-44d0"
	jiraCloudID     = "acme-cloud-1"
	jiraField       = "customfield_10420"
)

func jiraAdminPath() string {
	return "/api/orgs/" + store.DefaultOrgSlug + "/admin/jira"
}

func jiraWritePath(slug string) string {
	return "/api/orgs/" + store.DefaultOrgSlug + "/spaces/" + slug + "/jira-write"
}

func jiraPasteBody(cloudID, fieldID, clientID, secret string) string {
	raw, _ := json.Marshal(map[string]any{
		"cloudId":      cloudID,
		"fieldId":      fieldID,
		"clientId":     clientID,
		"clientSecret": secret,
		"issueBody":    jiraIssueBody,
		"accessToken":  jiraAccessToken,
		"orgId":        "00000000-0000-0000-0000-000000000099",
	})
	return string(raw)
}

func jiraServer(t *testing.T, key string) (*httptest.Server, *pgxpool.Pool, *plugin.Store, *http.Cookie, string) {
	t.Helper()
	pool := testPool(t)
	plugins := &plugin.Store{Pool: pool}
	if key != "" {
		cipher, err := plugin.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		plugins.Cipher = cipher
	}
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: plugins})
	admin, adminID := signupWithID(t, srv, "Operator")
	makeOrgAdmin(t, pool, adminID)
	_, created := createSpace(t, srv, "Jira Space "+randomSlugSuffix(t), admin)
	slug, _ := created["slug"].(string)
	if slug == "" {
		t.Fatalf("space creation returned no slug: %v", created)
	}
	return srv, pool, plugins, admin, slug
}

func jiraCount(t *testing.T, pool *pgxpool.Pool, orgID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), "select count(*) from jira_connections where org_id = $1", orgID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestJiraPasteWithoutASecretKeyWritesNothing(t *testing.T) {
	srv, pool, _, admin, _ := jiraServer(t, "")
	orgID := defaultOrg(t, pool)
	resp, body := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, jiraField, jiraClientID, jiraSecret), admin)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("put without a key: got %d %v, want 503", resp.StatusCode, body)
	}
	raw, _ := json.Marshal(body)
	if !strings.Contains(string(raw), "PLUGIN_SECRET_KEY") {
		t.Fatalf("503 did not name PLUGIN_SECRET_KEY: %s", raw)
	}
	if n := jiraCount(t, pool, orgID); n != 0 {
		t.Fatalf("a refused paste stored %d rows", n)
	}
	resp, body = doJSON(t, srv, http.MethodGet, jiraAdminPath(), "", admin)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("get without a key: got %d %v, want 503", resp.StatusCode, body)
	}
}

func TestOrgAdminSavesOneJiraConnection(t *testing.T) {
	srv, pool, plugins, admin, _ := jiraServer(t, jiraKey)
	orgID := defaultOrg(t, pool)
	logs := captureDefaultJSON(t)

	resp, body := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, jiraField, jiraClientID, jiraSecret), admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put: got %d %v", resp.StatusCode, body)
	}
	if jiraCount(t, pool, orgID) != 1 {
		t.Fatalf("rows = %d, want 1", jiraCount(t, pool, orgID))
	}
	var id, generation, ciphertext string
	if err := pool.QueryRow(context.Background(), `
		select id::text, generation::text, encode(ciphertext, 'hex')
		from jira_connections where org_id = $1`, orgID).Scan(&id, &generation, &ciphertext); err != nil {
		t.Fatal(err)
	}
	resp, got := doJSON(t, srv, http.MethodGet, jiraAdminPath(), "", admin)
	if resp.StatusCode != http.StatusOK || got["cloudId"] != jiraCloudID || got["fieldId"] != jiraField || got["generation"] != generation || got["secretStored"] != true {
		t.Fatalf("get: got %d %v", resp.StatusCode, got)
	}
	if got["configured"] != true {
		t.Fatalf("get configured: %v", got)
	}

	resp, again := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody("acme-cloud-2", jiraField, jiraClientID, ""), admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("second put: got %d %v", resp.StatusCode, again)
	}
	if jiraCount(t, pool, orgID) != 1 {
		t.Fatal("saving again inserted a second row")
	}
	var id2, generation2, ciphertext2 string
	if err := pool.QueryRow(context.Background(), `
		select id::text, generation::text, encode(ciphertext, 'hex')
		from jira_connections where org_id = $1`, orgID).Scan(&id2, &generation2, &ciphertext2); err != nil {
		t.Fatal(err)
	}
	if id2 != id || generation2 == generation || ciphertext2 != ciphertext {
		t.Fatalf("update id/generation/secret = %s %s %s, want same id, new generation, same secret", id2, generation2, ciphertext2)
	}
	plain := openJira(t, pool, plugins.Cipher, id, orgID)
	if plain != jiraSecret {
		t.Fatalf("kept secret opened as %q", plain)
	}

	resp, _ = doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody("acme-cloud-2", jiraField, "replaced-client", "jira-client-secret-canary-next"), admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("secret rotation: %d", resp.StatusCode)
	}
	if openJira(t, pool, plugins.Cipher, id, orgID) != "jira-client-secret-canary-next" {
		t.Fatal("a pasted secret did not replace the stored one")
	}
	if jiraCount(t, pool, orgID) != 1 {
		t.Fatal("rotation inserted a row")
	}

	var stored string
	if err := pool.QueryRow(context.Background(), `
		select coalesce(cloud_id,'')||coalesce(field_id,'')||coalesce(client_id,'')||coalesce(generation::text,'')||encode(ciphertext,'hex')
		from jira_connections where org_id = $1`, orgID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, jiraIssueBody) || strings.Contains(stored, jiraAccessToken) {
		t.Fatalf("the row stored an issue body or access token: %s", stored)
	}
	var issueColumn int
	if err := pool.QueryRow(context.Background(), `
		select count(*) from information_schema.columns
		where table_name = 'jira_connections' and column_name in ('issue_body', 'access_token')`).Scan(&issueColumn); err != nil {
		t.Fatal(err)
	}
	if issueColumn != 0 {
		t.Fatalf("jira_connections has %d issue or token columns", issueColumn)
	}
	if strings.Contains(logs.String(), jiraSecret) || strings.Contains(logs.String(), jiraClientID) || strings.Contains(logs.String(), jiraAccessToken) || strings.Contains(logs.String(), ciphertext) {
		t.Fatalf("slog recorded a credential:\n%s", logs.String())
	}
	var installs int
	if err := pool.QueryRow(context.Background(), "select count(*) from plugin_installs").Scan(&installs); err != nil {
		t.Fatal(err)
	}
	if installs != 0 {
		t.Fatal("the paste created a plugin install")
	}
}

func TestJiraFieldIDMustBeACustomField(t *testing.T) {
	srv, pool, _, admin, _ := jiraServer(t, jiraKey)
	orgID := defaultOrg(t, pool)
	for _, fieldID := range []string{"Story points", "customfield_", "customfield_12a", "customfield_10016 ", ""} {
		resp, body := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, fieldID, jiraClientID, jiraSecret), admin)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("field %q: got %d %v, want 400", fieldID, resp.StatusCode, body)
		}
	}
	if n := jiraCount(t, pool, orgID); n != 0 {
		t.Fatalf("a refused field id stored %d rows", n)
	}
}

func TestJiraConnectionIsTheRequestOrg(t *testing.T) {
	srv, pool, _, admin, _ := jiraServer(t, jiraKey)
	orgID := defaultOrg(t, pool)
	var other string
	if err := pool.QueryRow(context.Background(),
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id::text", "other-"+randomSlugSuffix(t),
	).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `
		insert into jira_connections (id, org_id, cloud_id, field_id, client_id, generation, nonce, ciphertext, key_id)
		values (gen_random_uuid(), $1, 'foreign-cloud', 'customfield_99999', 'foreign-client', gen_random_uuid(), '\x00', '\x00', 'k')`, other); err != nil {
		t.Fatal(err)
	}
	resp, body := doJSON(t, srv, http.MethodGet, jiraAdminPath(), "", admin)
	raw, _ := json.Marshal(body)
	if resp.StatusCode != http.StatusOK || strings.Contains(string(raw), "foreign-cloud") || body["configured"] == true {
		t.Fatalf("default org saw a foreign connection: %d %s", resp.StatusCode, raw)
	}
	var otherSlug string
	if err := pool.QueryRow(context.Background(), "select slug from orgs where id = $1", other).Scan(&otherSlug); err != nil {
		t.Fatal(err)
	}
	resp, body = doJSON(t, srv, http.MethodGet, "/api/orgs/"+otherSlug+"/admin/jira", "", admin)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign org: got %d %v, want 404", resp.StatusCode, body)
	}
	resp, _ = doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, jiraField, jiraClientID, jiraSecret), admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put: %d", resp.StatusCode)
	}
	var wrote string
	if err := pool.QueryRow(context.Background(), "select org_id::text from jira_connections where cloud_id = $1", jiraCloudID).Scan(&wrote); err != nil {
		t.Fatal(err)
	}
	if wrote != orgID {
		t.Fatalf("paste bound to org %s, want %s", wrote, orgID)
	}
	var foreignCloud string
	if err := pool.QueryRow(context.Background(), "select cloud_id from jira_connections where org_id = $1", other).Scan(&foreignCloud); err != nil {
		t.Fatal(err)
	}
	if foreignCloud != "foreign-cloud" {
		t.Fatal("the paste rewrote another org's connection")
	}
}

func TestJiraPasteIsOrgAdminOnly(t *testing.T) {
	srv, _, _, admin, slug := jiraServer(t, jiraKey)
	member := signup(t, srv, "Member")
	_, sp := doJSON(t, srv, http.MethodGet, "/api/orgs/default/spaces/"+slug, "", admin)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, slug, member, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	if resp, body := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, jiraField, jiraClientID, jiraSecret), member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member put: got %d %v, want 403", resp.StatusCode, body)
	}
	if resp, body := doJSON(t, srv, http.MethodGet, jiraAdminPath(), "", member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member get: got %d %v, want 403", resp.StatusCode, body)
	}
	if resp, _ := doJSON(t, srv, http.MethodGet, jiraAdminPath(), "", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous get: %d", resp.StatusCode)
	}
}

func TestJiraWriteSwitchIsTheSpaceOwner(t *testing.T) {
	srv, pool, _, owner, slug := jiraServer(t, jiraKey)
	orgID := defaultOrg(t, pool)
	outsider, outsiderID := signupWithID(t, srv, "Admin Outsider")
	makeOrgAdmin(t, pool, outsiderID)
	member := signup(t, srv, "Member")
	_, sp := doJSON(t, srv, http.MethodGet, "/api/orgs/default/spaces/"+slug, "", owner)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, slug, member, code); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}

	resp, body := doJSON(t, srv, http.MethodGet, jiraWritePath(slug), "", outsider)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("org admin who is not a member: got %d %v, want 404", resp.StatusCode, body)
	}
	resp, body = doJSON(t, srv, http.MethodGet, jiraWritePath(slug), "", member)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member: got %d %v, want 403", resp.StatusCode, body)
	}

	resp, body = doJSON(t, srv, http.MethodGet, jiraWritePath(slug), "", owner)
	if resp.StatusCode != http.StatusOK || body["configured"] != false || body["writeEnabled"] != false {
		t.Fatalf("unconfigured switch: got %d %v", resp.StatusCode, body)
	}
	resp, body = doJSON(t, srv, http.MethodPut, jiraWritePath(slug), `{"writeEnabled":true}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("enable without a connection: got %d %v, want 400", resp.StatusCode, body)
	}
	if writeEnabled(t, pool, orgID, slug) {
		t.Fatal("the switch armed a space that has no connection")
	}
	resp, body = doJSON(t, srv, http.MethodPut, jiraWritePath(slug), `{"writeEnabled":true,"connectionId":"00000000-0000-0000-0000-000000000001"}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("switch took a connection id: got %d %v", resp.StatusCode, body)
	}

	if resp, _ := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, jiraField, jiraClientID, jiraSecret), owner); resp.StatusCode != http.StatusOK {
		t.Fatal("owner admin could not paste")
	}
	_, other := createSpace(t, srv, "Other Jira Space "+randomSlugSuffix(t), owner)
	otherSlug, _ := other["slug"].(string)
	resp, body = doJSON(t, srv, http.MethodPut, jiraWritePath(slug), `{"writeEnabled":true}`, owner)
	if resp.StatusCode != http.StatusOK || body["writeEnabled"] != true || body["configured"] != true {
		t.Fatalf("enable: got %d %v", resp.StatusCode, body)
	}
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), jiraSecret) || strings.Contains(string(raw), jiraClientID) || strings.Contains(string(raw), "ciphertext") {
		t.Fatalf("switch JSON carried a credential: %s", raw)
	}
	if !writeEnabled(t, pool, orgID, slug) || writeEnabled(t, pool, orgID, otherSlug) {
		t.Fatal("the switch did not stay on this space")
	}
	resp, body = doJSON(t, srv, http.MethodPut, jiraWritePath(slug), `{"writeEnabled":false}`, owner)
	if resp.StatusCode != http.StatusOK || body["writeEnabled"] != false {
		t.Fatalf("disable: got %d %v", resp.StatusCode, body)
	}
	if writeEnabled(t, pool, orgID, slug) {
		t.Fatal("disable left the flag on")
	}
}

func TestJiraCredentialsStayOutOfJSONCSVAndLogs(t *testing.T) {
	srv, pool, _, admin, slug := jiraServer(t, jiraKey)
	orgID := defaultOrg(t, pool)
	logs := captureDefaultJSON(t)
	resp, connection := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, jiraField, jiraClientID, jiraSecret), admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put: %d %v", resp.StatusCode, connection)
	}
	_, got := doJSON(t, srv, http.MethodGet, jiraAdminPath(), "", admin)
	connectionJSON, _ := json.Marshal(got)
	if resp, _ = doJSON(t, srv, http.MethodPut, jiraWritePath(slug), `{"writeEnabled":true}`, admin); resp.StatusCode != http.StatusOK {
		t.Fatalf("switch: %d", resp.StatusCode)
	}
	_, switched := doJSON(t, srv, http.MethodGet, jiraWritePath(slug), "", admin)
	switchJSON, _ := json.Marshal(switched)

	resp, sess := createSession(t, srv, slug, "poker", "Sprint", admin)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("session: %d %v", resp.StatusCode, sess)
	}
	id := sess["id"].(string)
	storyResp, storyBody := doJSON(t, srv, http.MethodPost, "/api/sessions/"+id+"/actions/stories", `{"title":"Estimate the door"}`, admin)
	storyJSON, _ := json.Marshal(storyBody)
	if storyResp.StatusCode != http.StatusNoContent {
		t.Fatalf("story save: %d %v", storyResp.StatusCode, storyBody)
	}
	_, env := doJSON(t, srv, http.MethodGet, "/api/sessions/"+id, "", admin)
	savedJSON, _ := json.Marshal(env)
	csvResp, csvBody := fetchCSV(t, srv, id, admin)
	if csvResp.StatusCode != http.StatusOK {
		t.Fatalf("csv: %d", csvResp.StatusCode)
	}

	var nonce, ciphertext []byte
	if err := pool.QueryRow(context.Background(), "select nonce, ciphertext from jira_connections where org_id = $1", orgID).Scan(&nonce, &ciphertext); err != nil {
		t.Fatal(err)
	}
	needles := []string{
		jiraSecret, jiraClientID, jiraAccessToken, jiraIssueBody,
		base64.StdEncoding.EncodeToString(ciphertext), hex.EncodeToString(ciphertext),
		`"clientId"`, `"clientSecret"`, `"ciphertext"`, `"accessToken"`, `"nonce"`, `"keyId"`,
	}
	for _, surface := range []struct{ name, body string }{
		{"connection JSON", string(connectionJSON)},
		{"switch JSON", string(switchJSON)},
		{"story-save JSON", string(storyJSON) + string(savedJSON)},
		{"slog", logs.String()},
		{"exportCSV", csvBody},
	} {
		for _, needle := range needles {
			if needle != "" && strings.Contains(surface.body, needle) {
				t.Errorf("%s contains %q", surface.name, needle)
			}
		}
	}
}

func TestJiraConnectionResealCorruptAndWrongOrg(t *testing.T) {
	srv, pool, plugins, admin, _ := jiraServer(t, jiraKey)
	orgID := defaultOrg(t, pool)
	if resp, body := doJSON(t, srv, http.MethodPut, jiraAdminPath(), jiraPasteBody(jiraCloudID, jiraField, jiraClientID, jiraSecret), admin); resp.StatusCode != http.StatusOK {
		t.Fatalf("put: %d %v", resp.StatusCode, body)
	}
	var id string
	if err := pool.QueryRow(context.Background(), "select id::text from jira_connections where org_id = $1", orgID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	keyID, nonce, ciphertext := mustJiraMaterial(t, pool, orgID)
	if _, err := plugins.Cipher.OpenBound(keyID, jiraAAD(id, "00000000-0000-0000-0000-000000000099"), nonce, ciphertext); err == nil {
		t.Fatal("wrong-org additional data opened the secret")
	}
	if openJira(t, pool, plugins.Cipher, id, orgID) != jiraSecret {
		t.Fatal("the row did not open under its own org")
	}

	rotated, err := plugin.NewRotatingCipher(jiraPreviousKey, jiraKey)
	if err != nil {
		t.Fatal(err)
	}
	plugins.Cipher = rotated
	if openJira(t, pool, plugins.Cipher, id, orgID) != jiraSecret {
		t.Fatal("previous key did not open the connection")
	}
	stale, err := plugins.StaleSecrets(context.Background())
	if err != nil || stale != 1 {
		t.Fatalf("stale = %d %v, want 1", stale, err)
	}
	resealed, remaining, err := plugins.ResealSecrets(context.Background())
	if err != nil || resealed != 1 || remaining != 0 {
		t.Fatalf("reseal = (%d, %d, %v), want (1, 0, nil)", resealed, remaining, err)
	}
	current, err := plugin.NewCipher(jiraPreviousKey)
	if err != nil {
		t.Fatal(err)
	}
	if openJira(t, pool, current, id, orgID) != jiraSecret {
		t.Fatal("reseal did not move the secret onto the current key")
	}

	if _, err := pool.Exec(context.Background(), "update jira_connections set ciphertext = '\\x0001'::bytea where id = $1", id); err != nil {
		t.Fatal(err)
	}
	keyID, nonce, ciphertext = mustJiraMaterial(t, pool, orgID)
	if _, err := current.OpenBound(keyID, jiraAAD(id, orgID), nonce, ciphertext); err == nil {
		t.Fatal("corrupt ciphertext opened")
	}
	plugins.Cipher = current
	if _, remaining, err = plugins.ResealSecrets(context.Background()); err != nil || remaining != 1 {
		t.Fatalf("corrupt row remaining = %d %v, want 1", remaining, err)
	}
}

func jiraAAD(id, orgID string) []byte {
	return []byte("jira-connection|" + id + "|" + orgID)
}

func mustJiraMaterial(t *testing.T, pool *pgxpool.Pool, orgID string) (keyID string, nonce, ciphertext []byte) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), "select key_id, nonce, ciphertext from jira_connections where org_id = $1", orgID).Scan(&keyID, &nonce, &ciphertext); err != nil {
		t.Fatal(err)
	}
	return keyID, nonce, ciphertext
}

func openJira(t *testing.T, pool *pgxpool.Pool, cipher *plugin.Cipher, id, orgID string) string {
	t.Helper()
	keyID, nonce, ciphertext := mustJiraMaterial(t, pool, orgID)
	plain, err := cipher.OpenBound(keyID, jiraAAD(id, orgID), nonce, ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	return plain
}

func writeEnabled(t *testing.T, pool *pgxpool.Pool, orgID, slug string) bool {
	t.Helper()
	var on bool
	if err := pool.QueryRow(context.Background(), "select jira_write_enabled from spaces where org_id = $1 and slug = $2", orgID, slug).Scan(&on); err != nil {
		t.Fatal(err)
	}
	return on
}
