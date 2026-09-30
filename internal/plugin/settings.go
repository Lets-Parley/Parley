package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"unicode/utf8"
)

// Plugin settings are a flat JSON Schema subset a manifest declares and an org
// admin fills in. The validator is written out by hand for exactly that subset:
// a general JSON Schema engine would accept keywords this host never enforces,
// and a keyword the host ignores is a promise to the admin nobody keeps.
//
// A field with "format":"secret" is never stored with the other values. It is
// an implicit secrets:<field> grant, so it goes through the consent screen and
// the upgrade diff like any other secret, and the plugin reads it only through
// parley_secret_get.

// ErrBadSettingsSchema is a manifest settings schema outside the subset.
var ErrBadSettingsSchema = errors.New("the settings schema is not one Parley accepts")

const maxSettings = 32

var settingName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// SettingField is one declared setting.
type SettingField struct {
	Type        string   `json:"type"`
	Title       string   `json:"title,omitempty"`
	Description string   `json:"description,omitempty"`
	Default     any      `json:"default,omitempty"`
	Enum        []any    `json:"enum,omitempty"`
	Pattern     *string  `json:"pattern,omitempty"`
	Minimum     *float64 `json:"minimum,omitempty"`
	Maximum     *float64 `json:"maximum,omitempty"`
	MinLength   *int     `json:"minLength,omitempty"`
	MaxLength   *int     `json:"maxLength,omitempty"`
	Format      string   `json:"format,omitempty"`

	re *regexp.Regexp
}

// Secret reports whether the field is stored encrypted rather than as a value.
func (f *SettingField) Secret() bool { return f.Format == "secret" }

// SettingsSchema is a parsed manifest settings block. A nil schema declares
// no settings.
type SettingsSchema struct {
	Type                 string                   `json:"type"`
	Properties           map[string]*SettingField `json:"properties,omitempty"`
	Required             []string                 `json:"required,omitempty"`
	AdditionalProperties *bool                    `json:"additionalProperties,omitempty"`
}

func badSchema(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrBadSettingsSchema}, args...)...)
}

// ParseSettingsSchema screens a manifest's settings block. Absent or null is
// no settings at all.
func ParseSettingsSchema(raw json.RawMessage) (*SettingsSchema, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var s SettingsSchema
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return nil, badSchema("%v", err)
	}
	if s.Type != "object" {
		return nil, badSchema(`the type must be "object"`)
	}
	// Absent is read as false: there is no nesting and no extra keys.
	if s.AdditionalProperties != nil && *s.AdditionalProperties {
		return nil, badSchema("additionalProperties must be false")
	}
	if len(s.Properties) > maxSettings {
		return nil, badSchema("at most %d settings", maxSettings)
	}
	for name, f := range s.Properties {
		if !settingName.MatchString(name) {
			return nil, badSchema("%q is not a setting name (lowercase letters, digits and underscores, at most 40)", name)
		}
		if f == nil {
			return nil, badSchema("%q has no definition", name)
		}
		if err := f.check(); err != nil {
			return nil, badSchema("%q: %v", name, err)
		}
	}
	for _, r := range s.Required {
		if s.Properties[r] == nil {
			return nil, badSchema("%q is required but not declared", r)
		}
	}
	return &s, nil
}

func (f *SettingField) check() error {
	str := f.Type == "string"
	num := f.Type == "number" || f.Type == "integer"
	switch {
	case !str && !num && f.Type != "boolean":
		return fmt.Errorf("type %q is not string, number, integer or boolean", f.Type)
	case f.Format != "" && f.Format != "secret":
		return fmt.Errorf(`the only format is "secret"`)
	case f.Secret() && !str:
		return fmt.Errorf("a secret must be a string")
	case f.Secret() && (f.Default != nil || f.Enum != nil):
		return fmt.Errorf("a secret has no default and no enum")
	case !str && (f.Pattern != nil || f.MinLength != nil || f.MaxLength != nil):
		return fmt.Errorf("pattern, minLength and maxLength apply to strings")
	case !num && (f.Minimum != nil || f.Maximum != nil):
		return fmt.Errorf("minimum and maximum apply to numbers")
	case f.MinLength != nil && *f.MinLength < 0, f.MaxLength != nil && *f.MaxLength < 0:
		return fmt.Errorf("a length is negative")
	case f.MinLength != nil && f.MaxLength != nil && *f.MinLength > *f.MaxLength:
		return fmt.Errorf("minLength is above maxLength")
	case f.Minimum != nil && f.Maximum != nil && *f.Minimum > *f.Maximum:
		return fmt.Errorf("minimum is above maximum")
	case f.Enum != nil && len(f.Enum) == 0:
		return fmt.Errorf("enum is empty")
	}
	if f.Pattern != nil {
		re, err := regexp.Compile(*f.Pattern)
		if err != nil {
			return fmt.Errorf("the pattern does not compile: %v", err)
		}
		f.re = re
	}
	for _, v := range f.Enum {
		if msg := f.typeCheck(v); msg != "" {
			return fmt.Errorf("an enum value %s", msg)
		}
	}
	if f.Default != nil {
		if msg := f.valueCheck(f.Default); msg != "" {
			return fmt.Errorf("the default %s", msg)
		}
	}
	return nil
}

func (f *SettingField) typeCheck(v any) string {
	switch f.Type {
	case "string":
		if _, ok := v.(string); !ok {
			return "must be text"
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return "must be true or false"
		}
	default:
		n, ok := v.(float64)
		if !ok {
			return "must be a number"
		}
		if f.Type == "integer" && n != math.Trunc(n) {
			return "must be a whole number"
		}
	}
	return ""
}

// valueCheck is the message for a value that does not fit, "" when it does.
func (f *SettingField) valueCheck(v any) string {
	if msg := f.typeCheck(v); msg != "" {
		return msg
	}
	if f.Enum != nil {
		found := false
		for _, e := range f.Enum {
			if e == v {
				found = true
				break
			}
		}
		if !found {
			return "must be one of the listed choices"
		}
	}
	switch x := v.(type) {
	case string:
		n := utf8.RuneCountInString(x)
		if f.MinLength != nil && n < *f.MinLength {
			return fmt.Sprintf("must be at least %d characters", *f.MinLength)
		}
		if f.MaxLength != nil && n > *f.MaxLength {
			return fmt.Sprintf("must be at most %d characters", *f.MaxLength)
		}
		if f.re != nil && !f.re.MatchString(x) {
			return "does not match the required format"
		}
	case float64:
		if f.Minimum != nil && x < *f.Minimum {
			return fmt.Sprintf("must be at least %v", *f.Minimum)
		}
		if f.Maximum != nil && x > *f.Maximum {
			return fmt.Sprintf("must be at most %v", *f.Maximum)
		}
	}
	return ""
}

// ValidateSecret checks a secret's new value against its field.
func (s *SettingsSchema) ValidateSecret(name, value string) string {
	return s.Properties[name].valueCheck(value)
}

// Validate checks non-secret values, returning a message per field that does
// not fit. With required set it also refuses a missing required field — a
// non-secret with no default, or a secret not in secretsSet. Re-validating
// stored values at an upgrade passes required=false: a field the new version
// requires cannot have been filled in under the old one.
func (s *SettingsSchema) Validate(values map[string]any, secretsSet map[string]bool, required bool) map[string]string {
	bad := map[string]string{}
	var props map[string]*SettingField
	if s != nil {
		props = s.Properties
	}
	for name, v := range values {
		f := props[name]
		switch {
		case f == nil:
			bad[name] = "is not a setting this plugin declares"
		case f.Secret():
			bad[name] = "is a secret and is never stored as a plain value"
		default:
			if msg := f.valueCheck(v); msg != "" {
				bad[name] = msg
			}
		}
	}
	if s != nil && required {
		for _, name := range s.Required {
			f := props[name]
			if f.Secret() && !secretsSet[name] {
				bad[name] = "is required"
			}
			if _, ok := values[name]; !f.Secret() && !ok && f.Default == nil {
				bad[name] = "is required"
			}
		}
	}
	return bad
}

// Public is what the plugin reads through parley_settings_get: every declared
// non-secret field, its stored value or else its default. Nothing that is not
// declared, and never a secret, whatever the stored object holds.
func (s *SettingsSchema) Public(values map[string]any) map[string]any {
	out := map[string]any{}
	if s == nil {
		return out
	}
	for name, f := range s.Properties {
		if f.Secret() {
			continue
		}
		if v, ok := values[name]; ok {
			out[name] = v
		} else if f.Default != nil {
			out[name] = f.Default
		}
	}
	return out
}

// SecretFields names the secret fields, sorted.
func (s *SettingsSchema) SecretFields() []string {
	var out []string
	if s == nil {
		return out
	}
	for name, f := range s.Properties {
		if f.Secret() {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// SecretGrants is the implicit secrets:<field> grant for every secret field.
func (s *SettingsSchema) SecretGrants() []Grant {
	var out []Grant
	for _, name := range s.SecretFields() {
		out = append(out, Grant{Capability: CapabilitySecrets, Scope: name})
	}
	return out
}

// settingsQuery reads an install's stored values and the settings block of
// the bundle it is pinned to. An install with no stored bundle declares none.
const settingsQuery = `
	select coalesce(b.manifest->'settings', 'null'::jsonb), i.settings
	from plugin_installs i
	left join plugin_bundles b on b.digest = i.bundle_digest and b.key_id = i.bundle_key_id
	where i.id = $1`

// Settings reads an install's schema and stored non-secret values. It is
// read on every call; there is no cache to go stale after a PUT or upgrade.
func (s *Store) Settings(ctx context.Context, installID string) (*SettingsSchema, map[string]any, error) {
	var rawSchema, rawValues []byte
	if err := s.Pool.QueryRow(ctx, settingsQuery, installID).Scan(&rawSchema, &rawValues); err != nil {
		return nil, nil, fmt.Errorf("reading the settings of %s: %w", installID, err)
	}
	schema, err := ParseSettingsSchema(rawSchema)
	if err != nil {
		return nil, nil, err
	}
	values := map[string]any{}
	if err := json.Unmarshal(rawValues, &values); err != nil {
		return nil, nil, fmt.Errorf("reading the settings of %s: %w", installID, err)
	}
	return schema, values, nil
}

// SecretState reports whether a secret is stored and whether a configured key
// opens it. It is the only view of a secret the administration surface gets:
// the value is opened, checked and dropped here, never returned.
func (s *Store) SecretState(ctx context.Context, installID, name string) (set, undecryptable bool, err error) {
	if err := s.Pool.QueryRow(ctx,
		`select exists (select 1 from plugin_secrets where install_id = $1 and name = $2)`,
		installID, name).Scan(&set); err != nil || !set {
		return false, false, err
	}
	if s.Cipher == nil {
		return true, true, nil
	}
	_, err = s.GetSecret(ctx, installID, name)
	if errors.Is(err, ErrSecretUndecryptable) {
		return true, true, nil
	}
	return true, false, err
}

// DeleteSecret clears one secret. Clearing one that is not set is not an error.
func (s *Store) DeleteSecret(ctx context.Context, installID, name string) error {
	if _, err := s.Pool.Exec(ctx,
		`delete from plugin_secrets where install_id = $1 and name = $2`, installID, name); err != nil {
		return fmt.Errorf("clearing plugin secret %q: %w", name, err)
	}
	return nil
}

// Settings reads one of this org's installs' settings.
func (a *Admin) Settings(ctx context.Context, installID string) (*SettingsSchema, map[string]any, error) {
	if err := a.own(ctx, installID); err != nil {
		return nil, nil, err
	}
	return a.s.Settings(ctx, installID)
}

// SecretState reports one of this org's installs' secret as set or not.
func (a *Admin) SecretState(ctx context.Context, installID, name string) (set, undecryptable bool, err error) {
	if err := a.own(ctx, installID); err != nil {
		return false, false, err
	}
	return a.s.SecretState(ctx, installID, name)
}

// SaveSettings writes validated values and secret changes for one of this
// org's installs. secrets maps a field to its new value, or to nil to clear
// it; a field not in the map is left alone. The caller has validated both.
//
// The values and each secret are separate writes; a failure part way
// leaves the earlier ones applied. The admin sees the error and saves again.
func (a *Admin) SaveSettings(ctx context.Context, installID string, values map[string]any, secrets map[string]*string) error {
	if err := a.own(ctx, installID); err != nil {
		return err
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return fmt.Errorf("encoding the settings of %s: %w", installID, err)
	}
	if _, err := a.s.Pool.Exec(ctx,
		`update plugin_installs set settings = $3 where id = $1 and org_id = $2`,
		installID, a.orgID, raw); err != nil {
		return fmt.Errorf("writing the settings of %s: %w", installID, err)
	}
	for name, v := range secrets {
		if v == nil {
			err = a.s.DeleteSecret(ctx, installID, name)
		} else {
			err = a.s.PutSecret(ctx, installID, name, *v)
		}
		if err != nil {
			return err
		}
	}
	return nil
}
