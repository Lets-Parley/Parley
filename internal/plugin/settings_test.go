package plugin

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/plugin/bundle"
)

const demoSchema = `{
	"type": "object",
	"properties": {
		"channel": {"type": "string", "title": "Channel", "pattern": "^#[a-z]+$", "default": "#general"},
		"size": {"type": "integer", "minimum": 1, "maximum": 10},
		"ratio": {"type": "number", "minimum": 0.5},
		"mode": {"type": "string", "enum": ["fast", "slow"]},
		"loud": {"type": "boolean", "default": true},
		"name": {"type": "string", "minLength": 2, "maxLength": 4},
		"token": {"type": "string", "format": "secret"}
	},
	"required": ["mode", "token"],
	"additionalProperties": false
}`

func mustSchema(t *testing.T, raw string) *SettingsSchema {
	t.Helper()
	s, err := ParseSettingsSchema(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestASettingsSchemaOutsideTheSubsetIsRefused(t *testing.T) {
	long := `{"type":"object","properties":{`
	for i := 0; i < 33; i++ {
		if i > 0 {
			long += ","
		}
		long += `"f` + strings.Repeat("a", i%3) + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `":{"type":"boolean"}`
	}
	long += `}}`
	for name, raw := range map[string]string{
		"not an object":        `{"type":"array"}`,
		"nested object":        `{"type":"object","properties":{"a":{"type":"object"}}}`,
		"array field":          `{"type":"object","properties":{"a":{"type":"array"}}}`,
		"bad name":             `{"type":"object","properties":{"Bad":{"type":"string"}}}`,
		"additional allowed":   `{"type":"object","additionalProperties":true}`,
		"unknown keyword":      `{"type":"object","properties":{"a":{"type":"string","oneOf":[]}}}`,
		"unknown top keyword":  `{"type":"object","$defs":{}}`,
		"secret on a number":   `{"type":"object","properties":{"a":{"type":"number","format":"secret"}}}`,
		"other format":         `{"type":"object","properties":{"a":{"type":"string","format":"email"}}}`,
		"bad pattern":          `{"type":"object","properties":{"a":{"type":"string","pattern":"("}}}`,
		"pattern on a number":  `{"type":"object","properties":{"a":{"type":"number","pattern":"x"}}}`,
		"minimum on a string":  `{"type":"object","properties":{"a":{"type":"string","minimum":1}}}`,
		"required unknown":     `{"type":"object","properties":{"a":{"type":"string"}},"required":["b"]}`,
		"default off enum":     `{"type":"object","properties":{"a":{"type":"string","enum":["x"],"default":"y"}}}`,
		"enum of wrong type":   `{"type":"object","properties":{"a":{"type":"integer","enum":["x"]}}}`,
		"default on a secret":  `{"type":"object","properties":{"a":{"type":"string","format":"secret","default":"x"}}}`,
		"too many properties":  long,
		"min above max length": `{"type":"object","properties":{"a":{"type":"string","minLength":3,"maxLength":2}}}`,
		"negative length":      `{"type":"object","properties":{"a":{"type":"string","minLength":-1}}}`,
		"not json":             `{`,
	} {
		if _, err := ParseSettingsSchema(json.RawMessage(raw)); !errors.Is(err, ErrBadSettingsSchema) {
			t.Errorf("%s: got %v, want ErrBadSettingsSchema", name, err)
		}
	}
	for _, raw := range []string{"", "null", `{"type":"object"}`, demoSchema} {
		if _, err := ParseSettingsSchema(json.RawMessage(raw)); err != nil {
			t.Errorf("%q: %v, want accepted", raw, err)
		}
	}
}

func TestSettingsValuesAreCheckedAgainstTheSchema(t *testing.T) {
	s := mustSchema(t, demoSchema)
	set := map[string]bool{"token": true}
	ok := map[string]any{"mode": "fast", "channel": "#dev", "size": 3.0, "ratio": 0.5, "name": "abc", "loud": false}
	if bad := s.Validate(ok, set, true); len(bad) != 0 {
		t.Fatalf("valid values refused: %v", bad)
	}
	for field, value := range map[string]any{
		"channel": "general",  // pattern
		"size":    3.5,        // integer
		"ratio":   0.1,        // minimum
		"mode":    "medium",   // enum
		"loud":    "yes",      // type
		"name":    "abcdefgh", // maxLength
		"token":   "sneaky",   // a secret is never a plain value
		"extra":   "x",        // additionalProperties
	} {
		values := map[string]any{"mode": "fast"}
		values[field] = value
		bad := s.Validate(values, set, true)
		if _, found := bad[field]; !found || len(bad) != 1 {
			t.Errorf("%s=%v: got %v, want exactly that field refused", field, value, bad)
		}
	}
	// Required: a non-secret with no default must be present, a secret set.
	bad := s.Validate(map[string]any{}, map[string]bool{}, true)
	if !reflect.DeepEqual(keys(bad), []string{"mode", "token"}) {
		t.Fatalf("missing required: %v, want mode and token", bad)
	}
	if bad := s.Validate(map[string]any{}, nil, false); len(bad) != 0 {
		t.Fatalf("required is not checked when re-validating stored values: %v", bad)
	}
}

func TestPublicSettingsApplyDefaultsAndNeverCarryASecret(t *testing.T) {
	s := mustSchema(t, demoSchema)
	got := s.Public(map[string]any{"mode": "slow", "token": "leaked", "gone": 1.0})
	want := map[string]any{"mode": "slow", "channel": "#general", "loud": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("public = %v, want %v", got, want)
	}
	if got := (*SettingsSchema)(nil).Public(nil); got == nil || len(got) != 0 {
		t.Fatalf("no schema = %v, want an empty object", got)
	}
}

func TestASecretSettingIsAnImplicitScopedSecretsGrant(t *testing.T) {
	s := mustSchema(t, demoSchema)
	if got := s.SecretGrants(); !reflect.DeepEqual(got, []Grant{{Capability: CapabilitySecrets, Scope: "token"}}) {
		t.Fatalf("grants = %v", got)
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// parley_settings_get needs no grant, answers the stored values over the
// defaults, never a secret, and re-reads on every call.
func TestSettingsGetReadsFreshNonSecretValues(t *testing.T) {
	store := &Store{Pool: testPool(t)}
	ctx := context.Background()
	key := testKey(t)
	bs := &BundleStore{Pool: store.Pool, Trusted: []ed25519.PublicKey{pubOf(key)}, Log: quietLogger()}
	name := uniqueName(t)
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": guestNoop()},
		[]byte(fmt.Sprintf(`{"name":%q,"version":"1.0.0","settings":%s}`, name, demoSchema)), key)
	if err != nil {
		t.Fatal(err)
	}
	b, err := bs.Insert(ctx, data, nil)
	if err != nil {
		t.Fatal(err)
	}
	in, err := store.Install(ctx, InstallRequest{OrgID: testOrgID, Name: name, Version: "1.0.0",
		QuotaBytes: 1024, Bundle: &BundleRef{Digest: b.Digest, KeyID: b.KeyID}})
	if err != nil {
		t.Fatal(err)
	}
	h := &Host{Store: store}
	get := func() map[string]any {
		t.Helper()
		out, err := h.settingsGet(ctx, State{Install: in}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return out.(map[string]any)
	}
	if got := get(); !reflect.DeepEqual(got, map[string]any{"channel": "#general", "loud": true}) {
		t.Fatalf("defaults = %v", got)
	}
	if _, err := store.Pool.Exec(ctx, `update plugin_installs set settings = '{"mode":"fast","token":"x"}' where id = $1`, in.ID); err != nil {
		t.Fatal(err)
	}
	if got := get(); got["mode"] != "fast" || got["token"] != nil {
		t.Fatalf("after a write = %v, want mode fast and no token", got)
	}
}

func TestSettingsGetIsARegisteredHostFunction(t *testing.T) {
	h, in := hosted(t, guestCallsHost("parley_settings_get"), HostConfig{}, 1024)
	_, report, err := h.CallWithReport(context.Background(), in.ID, "run", nil, ModeAsync)
	if err != nil || len(report.HostErrors) != 0 {
		t.Fatalf("call = %v, refusals %v", err, report.HostErrors)
	}
}
