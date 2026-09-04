//go:build plugindev

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func init() {
	routeScoping["POST /api/orgs/{org}/admin/plugins/dev-register"] = "org-scoped"
	linkGuestRouteTable["POST /api/orgs/{org}/admin/plugins/dev-register"] = linkRouteExpectation{
		status: http.StatusUnauthorized,
	}
}

// TestDevRegisterInstallsWithoutGrantsAccepted is the reason the route is
// tagged out of the default binary: one POST installs without the consent
// field the production path refuses to omit.
func TestDevRegisterInstallsWithoutGrantsAccepted(t *testing.T) {
	srv, _, _, admin, _ := pluginServer(t)
	name := newPluginName(t)
	body := `{"package":` + pluginPkg(name, "0.1.0", map[string]string{"capability": "kv", "scope": "board"}) + `}`
	req, err := http.NewRequest(http.MethodPost, srv.URL+pluginsPath+"/dev-register", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(admin)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("dev-register: got %d %s, want 201", resp.StatusCode, raw)
	}
	var view map[string]any
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if view["name"] != name {
		t.Fatalf("installed name: got %v", view["name"])
	}

	// The production install still refuses the same body without the tag's
	// route — grantsAccepted remains required there.
	got, err := requestStatus(srv, http.MethodPost, pluginsPath, body, admin)
	if err != nil {
		t.Fatal(err)
	}
	if got != http.StatusBadRequest {
		t.Fatalf("production install without grantsAccepted: got %d, want 400", got)
	}
}
