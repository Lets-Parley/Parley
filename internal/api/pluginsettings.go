package api

import (
	"context"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/plugin"
)

// An install's settings, as the admin surface reads and writes them. The
// routes sit in the plugin admin tree, so they have its gate, and every lookup
// goes through plugin.Admin, so a foreign install is 404.
//
// A secret is write-only here. GET says whether each one is set and whether a
// configured key opens it, and nothing else; the value is opened and dropped
// inside plugin.Store.SecretState and never reaches this package.

// maxSettingsBody caps a PUT well under the API-wide JSON cap: 32 settings do
// not need 64 KiB.
const maxSettingsBody = 16 << 10

type secretStatus struct {
	Set           bool `json:"set"`
	Undecryptable bool `json:"undecryptable"`
}

type settingsView struct {
	Schema  *plugin.SettingsSchema  `json:"schema"`
	Values  map[string]any          `json:"values"`
	Secrets map[string]secretStatus `json:"secrets"`
}

func (a *app) settingsView(ctx context.Context, adm *plugin.Admin, id string) (settingsView, error) {
	schema, stored, err := adm.Settings(ctx, id)
	if err != nil {
		return settingsView{}, err
	}
	out := settingsView{Schema: schema, Values: schema.Public(stored), Secrets: map[string]secretStatus{}}
	// Public fills in defaults; the form wants only what was saved.
	for name := range out.Values {
		if _, saved := stored[name]; !saved {
			delete(out.Values, name)
		}
	}
	for _, name := range schema.SecretFields() {
		set, undecryptable, err := adm.SecretState(ctx, id, name)
		if err != nil {
			return settingsView{}, err
		}
		out.Secrets[name] = secretStatus{Set: set, Undecryptable: undecryptable}
	}
	return out, nil
}

func (a *app) handleGetPluginSettings(w http.ResponseWriter, r *http.Request) {
	if !a.requirePluginStore(w) {
		return
	}
	view, err := a.settingsView(r.Context(), a.pluginAdmin(r), chi.URLParam(r, "id"))
	if notFoundInstall(w, err) {
		return
	}
	if err != nil {
		a.pluginError(w, err, "could not read that plugin's settings")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handlePutPluginSettings replaces the non-secret values with the body's —
// null or absent falls back to the default — and, for a secret field, a
// string sets it, null clears it and absent leaves it alone.
func (a *app) handlePutPluginSettings(w http.ResponseWriter, r *http.Request) {
	if !a.requirePluginStore(w) {
		return
	}
	var body map[string]any
	if err := httprequest.DecodeJSON(w, r, maxSettingsBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"the settings must be a JSON object"}`)
		return
	}
	id := chi.URLParam(r, "id")
	adm := a.pluginAdmin(r)
	state, err := adm.State(r.Context(), id)
	if notFoundInstall(w, err) {
		return
	}
	if err != nil {
		a.pluginError(w, err, "could not read that plugin's settings")
		return
	}
	schema, stored, err := adm.Settings(r.Context(), id)
	if err != nil {
		a.pluginError(w, err, "could not read that plugin's settings")
		return
	}

	values, secrets, bad := map[string]any{}, map[string]*string{}, map[string]string{}
	for name, v := range body {
		isSecret := schema != nil && schema.Properties[name] != nil && schema.Properties[name].Secret()
		switch x := v.(type) {
		case nil:
			if isSecret {
				secrets[name] = nil
			}
		case string:
			if isSecret {
				if msg := schema.ValidateSecret(name, x); msg != "" {
					bad[name] = msg
				}
				secrets[name] = &x
				continue
			}
			values[name] = v
		default:
			if isSecret {
				bad[name] = "must be text, or null to clear it"
				continue
			}
			values[name] = v
		}
	}
	setAfter := map[string]bool{}
	for _, name := range schema.SecretFields() {
		if v, changing := secrets[name]; changing {
			setAfter[name] = v != nil
			continue
		}
		if setAfter[name], _, err = adm.SecretState(r.Context(), id, name); err != nil {
			a.pluginError(w, err, "could not read that plugin's settings")
			return
		}
	}
	for name, msg := range schema.Validate(values, setAfter, true) {
		bad[name] = msg
	}
	if len(bad) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":  "some settings are not valid: " + strings.Join(fieldNames(bad), ", "),
			"fields": bad,
		})
		return
	}

	if err := adm.SaveSettings(r.Context(), id, values, secrets); err != nil {
		if notFoundInstall(w, err) {
			return
		}
		a.pluginError(w, err, "could not save that plugin's settings")
		return
	}
	a.auditPlugin(r, "plugin.settings", settingsAudit(state.Install.Name, stored, values, secrets))
	view, err := a.settingsView(r.Context(), adm, id)
	if err != nil {
		a.pluginError(w, err, "could not read that plugin's settings")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// settingsAudit names what changed, never a value: a setting can be as
// sensitive as a secret without being declared one.
func settingsAudit(name string, before, after map[string]any, secrets map[string]*string) string {
	changed := map[string]string{}
	for k, v := range after {
		if !reflect.DeepEqual(before[k], v) {
			changed[k] = ""
		}
	}
	for k := range before {
		if _, kept := after[k]; !kept {
			changed[k] = ""
		}
	}
	var set, cleared []string
	for k, v := range secrets {
		if v == nil {
			cleared = append(cleared, k)
		} else {
			set = append(set, k)
		}
	}
	sort.Strings(set)
	sort.Strings(cleared)
	out := "changed the settings of " + name
	if len(changed) > 0 {
		out += "; fields: " + strings.Join(fieldNames(changed), ", ")
	}
	if len(set) > 0 {
		out += "; set secrets: " + strings.Join(set, ", ")
	}
	if len(cleared) > 0 {
		out += "; cleared secrets: " + strings.Join(cleared, ", ")
	}
	return out
}

// settingsFit refuses a move to pkg while the saved values do not fit the
// schema it brings. Refusing is the safer of the two choices: dropping the
// values would silently change how a running plugin behaves. The admin changes
// or clears the named fields and tries again.
func (a *app) settingsFit(w http.ResponseWriter, r *http.Request, adm *plugin.Admin, id string, pkg pluginPackage) bool {
	_, stored, err := adm.Settings(r.Context(), id)
	if notFoundInstall(w, err) {
		return false
	}
	if err != nil {
		a.pluginError(w, err, "could not read that plugin's settings")
		return false
	}
	schema, _ := plugin.ParseSettingsSchema(pkg.Settings) // choose has validated it
	bad := schema.Validate(stored, nil, false)
	if len(bad) == 0 {
		return true
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": fmt.Sprintf("the saved settings do not fit %s %s: %s. Change or clear them, then try again.",
			pkg.Name, pkg.Version, strings.Join(fieldNames(bad), ", ")),
		"fields": bad,
	})
	return false
}

func fieldNames(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
