package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/session"
)

// A plugin lifecycle change reaches every replica without a restart. The
// second replica boots before the install exists, so the only way it can learn
// of the ceremony is the notification — and the disable is the one the
// circuit breaker makes, through Host.Disable, on whichever pod the failing
// calls landed.
func TestPluginKindsReachEveryReplicaWithoutARestart(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	storeB := &plugin.Store{Pool: pool}
	hostB := plugin.NewHost(storeB, plugin.HostConfig{})
	srvB := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: storeB, PluginHost: hostB})
	waitListening(t, srvB)

	storeA := &plugin.Store{Pool: pool}
	hostA := plugin.NewHost(storeA, plugin.HostConfig{})
	testServerWith(t, pool, Options{AllowedOrigin: testOrigin, Plugins: storeA, PluginHost: hostA})
	orgID := defaultOrg(t, pool)
	kind := "retro" + randomKindSuffix(t)
	in := installIn(t, storeA, orgID, plugin.KindDef{Kind: kind, Display: "Retrospective"})

	regB := hostB.Kinds.(*session.Registry)
	eventually(t, 5*time.Second, "the install to reach the second replica", func() bool {
		return regB.KnownInOrg(orgID, kind)
	})
	fac := signup(t, srvB, "Fay")
	_, sp := createSpace(t, srvB, "Replica Room", fac)
	if resp, body := createSession(t, srvB, sp["slug"].(string), kind, "Retro", fac); resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating the ceremony through the second replica: %d %v", resp.StatusCode, body)
	}

	if err := hostA.Disable(ctx, in.ID, "it degraded 3 times and the host gave up on it"); err != nil {
		t.Fatal(err)
	}
	eventually(t, 5*time.Second, "the disable to reach the second replica", func() bool {
		return !regB.Known(kind)
	})
	// There is no bundle to compile, so Enable errors after the enable has
	// committed — which is all this needs.
	_ = hostA.Enable(ctx, in.ID)
	eventually(t, 5*time.Second, "the re-enable to reach the second replica", func() bool {
		return regB.KnownInOrg(orgID, kind)
	})
}

// Installing is a lifecycle write like any other: the ceremony is creatable
// on the replica that served it the moment the install returns.
func TestAnInstalledCeremonyIsCreatableWithoutARestart(t *testing.T) {
	srv, pool, plugins, _ := hostServer(t)
	// The listener reconciles once when it subscribes. Let that pass first,
	// or it — not the install — could be what offers the kind.
	waitListening(t, srv)
	time.Sleep(300 * time.Millisecond)
	kind := "retro" + randomKindSuffix(t)
	installIn(t, plugins, defaultOrg(t, pool), plugin.KindDef{Kind: kind, Display: "Retrospective"})
	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Fresh Install Room", fac)
	if resp, body := createSession(t, srv, sp["slug"].(string), kind, "Retro", fac); resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a just-installed ceremony: %d %v", resp.StatusCode, body)
	}
}

func waitListening(t *testing.T, srv *httptest.Server) {
	t.Helper()
	eventually(t, 5*time.Second, "the replica to listen", func() bool {
		resp, err := http.Get(srv.URL + "/readyz")
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	})
}
