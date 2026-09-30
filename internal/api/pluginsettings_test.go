package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/plugin/bundle"
)

const settingsSchemaV1 = `{"type":"object","properties":{
	"channel":{"type":"string","pattern":"^#[a-z]+$","default":"#general"},
	"mode":{"type":"string","enum":["fast","slow"]},
	"token":{"type":"string","format":"secret"}},
	"required":["mode"],"additionalProperties":false}`

const secretValue = "s3cret-value-never-echoed"

// settingsServer is an operator with a secrets key, and one install of a
// plugin whose manifest declares settingsSchemaV1.
func settingsServer(t *testing.T) (digestFixture, string, string) {
	t.Helper()
	f := digestServer(t)
	cipher, err := plugin.NewCipher("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
	if err != nil {
		t.Fatal(err)
	}
	f.srv = testServerWith(t, f.pool, Options{AllowedOrigin: testOrigin,
		Plugins: &plugin.Store{Pool: f.pool, Cipher: cipher}, PluginBundles: f.bundle})
	name := newPluginName(t)
	code, view := f.post(t, "", `{"grantsAccepted":true,`+f.storeSettings(t, name, "1.0.0", settingsSchemaV1)+`}`)
	if code != http.StatusCreated {
		t.Fatalf("install = %d: %v", code, view)
	}
	id, _ := view["id"].(string)
	return f, name, id
}

func (f digestFixture) storeSettings(t *testing.T, name, version, schema string) string {
	t.Helper()
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm")},
		[]byte(fmt.Sprintf(`{"manifest":1,"kind":"plugin","name":%q,"version":%q,"capabilities":[{"capability":"log"}],"settings":%s}`,
			name, version, schema)), f.priv)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.bundle.Insert(context.Background(), data, nil)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf(`"digest":%q,"key_id":%q`, b.Digest, b.KeyID)
}

func (f digestFixture) settings(t *testing.T, method, id, body string) (int, string) {
	t.Helper()
	return f.settingsAt(t, pluginsPath, method, id, body)
}

func (f digestFixture) settingsAt(t *testing.T, base, method, id, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, f.srv.URL+base+"/"+id+"/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", testOrigin)
	req.AddCookie(f.admin)
	resp, err := f.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

func TestASecretSettingIsAGrantTheOperatorConsentsTo(t *testing.T) {
	f, _, id := settingsServer(t)
	resp, body := doJSON(t, f.srv, "GET", pluginsPath, "", f.admin)
	if resp.StatusCode != http.StatusOK {
		t.Fatal(resp.StatusCode)
	}
	installs, _ := body["installs"].([]any)
	for _, raw := range installs {
		view, _ := raw.(map[string]any)
		if view["id"] != id {
			continue
		}
		grants, _ := view["grants"].([]any)
		for _, g := range grants {
			if g, _ := g.(map[string]any); g["capability"] == "secrets" && g["scope"] == "token" {
				return
			}
		}
		t.Fatalf("the install holds no secrets:token grant: %v", view["grants"])
	}
	t.Fatalf("install %s is not listed", id)
}

func TestSettingsRoundTripWithoutEverReturningASecret(t *testing.T) {
	f, _, id := settingsServer(t)

	code, body := f.settings(t, "GET", id, "")
	if code != http.StatusOK || !strings.Contains(body, `"token":{"set":false,"undecryptable":false}`) {
		t.Fatalf("initial GET = %d %s", code, body)
	}

	code, body = f.settings(t, "PUT", id, `{"channel":"general","mode":"medium"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("invalid PUT = %d %s, want 400", code, body)
	}
	var refusal struct{ Fields map[string]string }
	_ = json.Unmarshal([]byte(body), &refusal)
	if refusal.Fields["channel"] == "" || refusal.Fields["mode"] == "" {
		t.Fatalf("the refusal does not name each field: %s", body)
	}
	if code, body = f.settings(t, "PUT", id, `{"channel":"#dev"}`); code != http.StatusBadRequest || !strings.Contains(body, `"mode":"is required"`) {
		t.Fatalf("missing required = %d %s", code, body)
	}

	code, body = f.settings(t, "PUT", id, `{"channel":"#dev","mode":"slow","token":"`+secretValue+`"}`)
	if code != http.StatusOK {
		t.Fatalf("valid PUT = %d %s", code, body)
	}
	code, body = f.settings(t, "GET", id, "")
	if code != http.StatusOK || strings.Contains(body, secretValue) {
		t.Fatalf("GET = %d and carries the secret: %s", code, body)
	}
	if !strings.Contains(body, `"token":{"set":true,"undecryptable":false}`) || !strings.Contains(body, `"mode":"slow"`) {
		t.Fatalf("GET after a save = %s", body)
	}
	detail := assertAudited(t, f.pool, "plugin.settings", f.id)
	if strings.Contains(detail, secretValue) || strings.Contains(detail, "slow") || !strings.Contains(detail, "token") {
		t.Fatalf("the audit row names values, or not the fields: %q", detail)
	}

	if code, body = f.settings(t, "PUT", id, `{"mode":"slow","token":null}`); code != http.StatusOK ||
		!strings.Contains(body, `"token":{"set":false`) {
		t.Fatalf("clearing the secret = %d %s", code, body)
	}
}

func TestTheSettingsBodyIsCapped(t *testing.T) {
	f, _, id := settingsServer(t)
	big := `{"mode":"slow","token":"` + strings.Repeat("x", 20<<10) + `"}`
	if code, body := f.settings(t, "PUT", id, big); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("a 20 KiB settings body = %d %s, want 413", code, body)
	}
}

func TestAnUpgradeThatWouldInvalidateSavedSettingsIsRefused(t *testing.T) {
	f, name, id := settingsServer(t)
	if code, body := f.settings(t, "PUT", id, `{"mode":"slow"}`); code != http.StatusOK {
		t.Fatalf("PUT = %d %s", code, body)
	}
	narrow := strings.Replace(settingsSchemaV1, `["fast","slow"]`, `["fast"]`, 1)
	v2 := f.storeSettings(t, name, "2.0.0", narrow)
	code, view := f.post(t, "", `{"grantsAccepted":true,`+v2+`}`)
	if code != http.StatusConflict || !strings.Contains(fmt.Sprint(view["error"]), "mode") {
		t.Fatalf("upgrade onto a schema the saved values break = %d %v, want 409 naming mode", code, view)
	}
	v0 := f.storeSettings(t, name, "0.9.0", narrow)
	if code, view := f.post(t, "/"+id+"/rollback", `{`+v0+`}`); code != http.StatusConflict {
		t.Fatalf("rollback onto it = %d %v, want 409", code, view)
	}

	// Approval re-checks: a widening upgrade that fit when requested, and a
	// value saved while it waited that the new schema refuses.
	wide := strings.Replace(narrow, `"token":`, `"key":{"type":"string","format":"secret"},"token":`, 1)
	if code, body := f.settings(t, "PUT", id, `{"mode":"fast"}`); code != http.StatusOK {
		t.Fatalf("PUT = %d %s", code, body)
	}
	v3 := f.storeSettings(t, name, "3.0.0", wide)
	if code, view := f.post(t, "", `{"grantsAccepted":true,`+v3+`}`); code != http.StatusAccepted {
		t.Fatalf("widening upgrade = %d %v, want 202", code, view)
	}
	if code, body := f.settings(t, "PUT", id, `{"mode":"slow"}`); code != http.StatusOK {
		t.Fatalf("PUT = %d %s", code, body)
	}
	if code, view := f.post(t, "/"+id+"/upgrade", `{"approve":true}`); code != http.StatusConflict {
		t.Fatalf("approval onto a schema the saved values break = %d %v, want 409", code, view)
	}
}

func TestABundleWithABadSettingsSchemaIs400(t *testing.T) {
	srv, pool, priv := catalogServer(t)
	curator, id := signupWithID(t, srv, "Curator")
	makeOrgAdmin(t, pool, id)
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm")},
		[]byte(`{"name":"cat`+randomKindSuffix(t)+`","version":"1.0.0","settings":{"type":"object","properties":{"a":{"type":"object"}}}}`), priv)
	if err != nil {
		t.Fatal(err)
	}
	if code, body := uploadBundle(t, srv, data, curator); code != http.StatusBadRequest || !strings.Contains(body, "settings") {
		t.Fatalf("a nested settings schema: got %d %s, want 400 naming the settings", code, body)
	}
}
