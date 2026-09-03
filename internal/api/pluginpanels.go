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

// handlePluginPanels lists the enabled installs that have a UI bundle on disk.
//
// It is a read of what is installed, not of what any plugin holds: the grants
// it returns are the same rows the host checks on every call, and they are
// returned so the browser can redact *more*, never so it can decide anything.
// The host re-checks every action regardless of what this said.
func (a *app) handlePluginPanels(w http.ResponseWriter, r *http.Request) {
	if a.pluginDir == "" || a.pool == nil {
		writeJSON(w, http.StatusOK, []panel{})
		return
	}
	panels, err := a.pluginPanels(r.Context())
	if err != nil {
		slog.Error("could not list plugin panels", "error", err)
		http.Error(w, `{"error":"could not list plugins"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, panels)
}

func (a *app) pluginPanels(ctx context.Context) ([]panel, error) {
	rows, err := a.pool.Query(ctx, `
		select i.name, i.version, coalesce(array_agg(g.capability) filter (where g.capability is not null), '{}')
		from plugin_installs i
		left join plugin_grants g on g.install_id = i.id
		where i.enabled
		group by i.name, i.version
		order by i.name`)
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
