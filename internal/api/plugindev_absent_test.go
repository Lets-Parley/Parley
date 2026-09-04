package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestDevRegisterIsAbsentFromTheDefaultBuild is the production half of the
// build-tag split: a binary built the way Docker and CI build it must not
// expose a path that installs a plugin without the consent check. Gating the
// same handler on an environment variable would still ship the code.
func TestDevRegisterIsAbsentFromTheDefaultBuild(t *testing.T) {
	routes, ok := Router(nil, Options{}).Handler.(chi.Routes)
	if !ok {
		t.Fatal("router is not walkable")
	}
	err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.Contains(route, "dev-register") {
			t.Errorf("%s %s shipped in the default build — the dev-registration endpoint must be behind the plugindev tag", method, route)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
