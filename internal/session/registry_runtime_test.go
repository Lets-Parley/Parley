package session

import (
	"net/http"
	"sync"
	"testing"
)

func aKind(name, orgID string) Kind {
	return Kind{
		Name:      name,
		OrgID:     orgID,
		NewConfig: func() any { return &struct{}{} },
		Actions: map[string]Action{
			"go": {Verb: http.MethodPost, Do: nil},
		},
	}
}

// A kind arriving from an install being enabled is registered while rooms are
// dispatching. The registry used to say outright that it was never written to
// after wiring, so this is the whole of the new contract: under -race, a
// register/unregister loop and a dispatch loop have to be able to run at once.
func TestRegisteringAKindWhileDispatchingIsRaceFree(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(aKind("poker", "")); err != nil {
		t.Fatalf("registering the core kind: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			if err := r.Register(aKind("retro", "org-a")); err != nil {
				t.Errorf("registering retro: %v", err)
				return
			}
			if err := r.Unregister("retro"); err != nil {
				t.Errorf("unregistering retro: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			_, _ = r.Action("poker", "go")
			_ = r.Known("poker")
			_ = r.Names()
			_ = r.KnownInOrg("org-a", "retro")
			_ = r.NamesInOrg("org-a")
		}
	}()
	wg.Wait()
}

// A kind a plugin provides belongs to the org that installed it. Org B must
// not be able to see it, and so must not be able to create a room of it.
func TestAPluginKindIsScopedToItsOwnOrg(t *testing.T) {
	r := NewRegistry()
	mustRegister(t, r, aKind("poker", ""))
	mustRegister(t, r, aKind("retro", "org-a"))

	if !r.KnownInOrg("org-a", "retro") {
		t.Error("org A cannot see the kind its own install provides")
	}
	if r.KnownInOrg("org-b", "retro") {
		t.Error("org B can see org A's plugin kind")
	}
	if !r.KnownInOrg("org-b", "poker") {
		t.Error("a core kind stopped being available to every org")
	}
	if got := r.NamesInOrg("org-b"); len(got) != 1 || got[0] != "poker" {
		t.Errorf("org B is offered %v, want only the core kind", got)
	}
	if got := r.NamesInOrg("org-a"); len(got) != 2 {
		t.Errorf("org A is offered %v, want both kinds", got)
	}
}

func mustRegister(t *testing.T, r *Registry, k Kind) {
	t.Helper()
	if err := r.Register(k); err != nil {
		t.Fatalf("registering %s: %v", k.Name, err)
	}
}
