//go:build plugindev

package api

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/plugin"
)

func init() {
	extraPluginMounts = append(extraPluginMounts, func(a *app, r chi.Router) {
		r.Post("/dev-register", a.handleDevRegisterPlugin)
	})
}

// handleDevRegisterPlugin installs a package without grantsAccepted. It exists
// only under the plugindev tag so a production binary cannot grow the same
// path by setting a variable.
func (a *app) handleDevRegisterPlugin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Package pluginPackage `json:"package"`
	}
	if err := httprequest.DecodeJSON(w, r, 64<<10, &req); err != nil {
		http.Error(w, `{"error":"that is not a plugin package"}`, http.StatusBadRequest)
		return
	}
	if !a.requirePluginStore(w) {
		return
	}
	if msg, ok := req.Package.validate(); !ok {
		http.Error(w, `{"error":`+jsonString(msg)+`}`, http.StatusBadRequest)
		return
	}
	pkg := req.Package
	grants := pkg.grants()
	adm := a.pluginAdmin(r)
	current, found, err := adm.ByName(r.Context(), pkg.Name)
	if err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	if !found {
		in, err := adm.Install(r.Context(), plugin.InstallRequest{
			Name: pkg.Name, Version: pkg.Version, Grants: grants,
			QuotaBytes: pkg.quota(), Kinds: pkg.Kinds,
		})
		if err != nil {
			a.pluginError(w, err, "could not install that plugin")
			return
		}
		a.auditPlugin(r, "plugin.dev_register",
			fmt.Sprintf("dev-registered %s %s", pkg.Name, pkg.Version))
		view, err := a.installView(r.Context(), adm, in.ID)
		if err != nil {
			http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, view)
		return
	}
	err = adm.Upgrade(r.Context(), current.Install.ID, pkg.Version, grants, pkg.Kinds)
	if err != nil {
		a.pluginError(w, err, "could not upgrade that plugin")
		return
	}
	a.auditPlugin(r, "plugin.dev_register",
		fmt.Sprintf("dev-registered %s %s", pkg.Name, pkg.Version))
	view, err := a.installView(r.Context(), adm, current.Install.ID)
	if err != nil {
		http.Error(w, `{"error":"could not read the installed plugins"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
