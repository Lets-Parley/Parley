package api

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// panel is one installed plugin that ships UI, as the room needs it: what to
// frame, and what it was granted so the bridge knows what to redact against.
type panel struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Grants  []string `json:"grants"`
}

// handlePluginPanels lists one org's enabled installs that have a UI bundle on
// disk.
//
// It is a read of what is installed, not of what any plugin holds: the grants
// it returns are the same rows the host checks on every call, and they are
// returned so the browser can redact *more*, never so it can decide anything.
// The host re-checks every action regardless of what this said.
//
// The org comes from the room, and the route is mounted under it for exactly
// that reason. A grant being safe to disclose — the host re-checks every one
// at the effect — says nothing about the *enumeration*: which plugins a tenant
// has installed is that tenant's metadata, and this route is reachable by a
// link guest, the least-trusted identity the product mints. Resolving the org
// from the room rather than defaulting it is what stops one link to one
// standup listing every install on the instance.
func (a *app) handlePluginPanels(w http.ResponseWriter, r *http.Request) {
	if a.pluginDir == "" || a.pool == nil {
		writeJSON(w, http.StatusOK, []panel{})
		return
	}
	org, err := a.orgs.BySpaceID(r.Context(), sessionFrom(r.Context()).SpaceID)
	if err != nil {
		slog.Error("could not resolve the org for a plugin panel list", "error", err)
		http.Error(w, `{"error":"could not list plugins"}`, http.StatusInternalServerError)
		return
	}
	panels, err := a.pluginPanels(r.Context(), org.ID)
	if err != nil {
		slog.Error("could not list plugin panels", "error", err)
		http.Error(w, `{"error":"could not list plugins"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, panels)
}

func (a *app) pluginPanels(ctx context.Context, orgID string) ([]panel, error) {
	rows, err := a.pool.Query(ctx, `
		select i.name, i.version, coalesce(array_agg(g.capability) filter (where g.capability is not null), '{}')
		from plugin_installs i
		left join plugin_grants g on g.install_id = i.id
		where i.enabled and i.org_id = $1
		group by i.name, i.version
		order by i.name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	panels := []panel{}
	for rows.Next() {
		var p panel
		if err := rows.Scan(&p.Name, &p.Version, &p.Grants); err != nil {
			return nil, err
		}
		// An install with no UI bundle is not a panel. Checking the file
		// rather than a database column keeps "has UI" a fact about what is
		// deployed, which is the thing the frame route will answer for.
		if !hasPluginUI(a.pluginDir, p.Name, p.Version) {
			continue
		}
		panels = append(panels, p)
	}
	return panels, rows.Err()
}

func hasPluginUI(dir, name, version string) bool {
	for _, field := range []string{name, version} {
		if field == "" || strings.ContainsAny(field, `/\`) || strings.Contains(field, "..") {
			return false
		}
	}
	info, err := os.Stat(filepath.Join(dir, name+"-"+version+".ui.js"))
	return err == nil && !info.IsDir()
}
