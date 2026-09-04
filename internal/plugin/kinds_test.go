package plugin

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
)

// installWithKinds records an install that declares the ceremonies it provides.
func installWithKinds(t *testing.T, s *Store, orgID string, kinds ...KindDef) Install {
	t.Helper()
	installNo++
	// session_kinds.provider caps at 64 characters and carries the install's
	// name, so the name stays short rather than failing as a check constraint.
	name := fmt.Sprintf("plug-%d-%d", time.Now().UnixNano(), installNo)
	in, err := s.Install(context.Background(), InstallRequest{
		OrgID: orgID, Name: name, Version: "1.0.0", QuotaBytes: 1024, Kinds: kinds,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, k := range kinds {
			_, _ = s.Pool.Exec(ctx, "delete from session_kinds where kind = $1", k.Kind)
		}
	})
	return in
}

func kindName(t *testing.T) string {
	t.Helper()
	installNo++
	return fmt.Sprintf("retro-%d-%d", time.Now().UnixNano(), installNo)
}

// The whole point of this issue: a ceremony arrives with an install and is on
// offer while that install is enabled, without a restart and without a commit
// to a core package.
func TestEnablingAnInstallOffersItsKindAndDisablingRetiresIt(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	kinds := session.NewRegistry()
	h := NewHost(s, HostConfig{})
	h.Kinds = kinds

	kind := kindName(t)
	in := installWithKinds(t, s, testOrgID, KindDef{
		Kind: kind, Display: "Retrospective",
		Actions: []ActionDef{{Name: "gather", Verb: http.MethodPost}, {Name: "close", Verb: http.MethodPost, FacilitatorOnly: true}},
	})

	if err := h.OfferKinds(ctx, in.ID); err != nil {
		t.Fatalf("offering the kinds of an enabled install: %v", err)
	}
	if !kinds.KnownInOrg(testOrgID, kind) {
		t.Fatal("an enabled install's ceremony is not on offer to its own org")
	}
	if kinds.KnownInOrg("11111111-1111-1111-1111-111111111111", kind) {
		t.Fatal("an install's ceremony is on offer to an org that never installed it")
	}
	act, ok := kinds.Action(kind, "close")
	if !ok || !act.FacilitatorOnly || act.Verb != http.MethodPost {
		t.Fatalf("the declared action came through as %+v (found=%v)", act, ok)
	}

	// Enabling twice must not fail on the registry's duplicate check.
	if err := h.OfferKinds(ctx, in.ID); err != nil {
		t.Fatalf("re-offering the kinds of an install that is already enabled: %v", err)
	}

	if err := h.Disable(ctx, in.ID, "an operator switched it off"); err != nil {
		t.Fatalf("disabling: %v", err)
	}
	if kinds.Known(kind) {
		t.Fatal("a disabled plugin's ceremony is still on offer")
	}
	// The row survives a disable: a disable is reversible, and rooms already
	// created with the kind still resolve their foreign key.
	var retired *time.Time
	if err := pool.QueryRow(ctx, "select retired_at from session_kinds where kind = $1", kind).Scan(&retired); err != nil {
		t.Fatalf("the session_kinds row did not survive a disable: %v", err)
	}
	if retired != nil {
		t.Fatal("a disable retired the kind, which only an uninstall may do")
	}

	// And a restart puts back exactly what was enabled.
	if err := s.SetEnabled(ctx, in.ID, true); err != nil {
		t.Fatal(err)
	}
	fresh := session.NewRegistry()
	h.Kinds = fresh
	if err := h.OfferEnabledKinds(ctx); err != nil {
		t.Fatalf("offering the kinds of every enabled install: %v", err)
	}
	if !fresh.Known(kind) {
		t.Fatal("a restart left an enabled plugin's ceremony unoffered")
	}
}

// A kind name is instance-wide because sessions.kind references it. An install
// that declares a name another org's install already provides is refused
// rather than quietly taking over that org's rooms.
func TestAnInstallCannotClaimAnotherOrgsKindName(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	kind := kindName(t)
	installWithKinds(t, s, testOrgID, KindDef{Kind: kind, Display: "Retrospective"})

	other := newOrg(t, pool)
	_, err := s.Install(context.Background(), InstallRequest{
		OrgID: other, Name: "rival-" + kind, Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: kind, Display: "Mine Now"}},
	})
	if !errors.Is(err, ErrKindTaken) {
		t.Fatalf("claiming another org's kind name: got %v, want ErrKindTaken", err)
	}
	var owner string
	if err := pool.QueryRow(context.Background(),
		"select org_id::text from session_kinds where kind = $1", kind).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != testOrgID {
		t.Fatalf("the kind now belongs to %s, want the org that installed it", owner)
	}
}

// A GET action is refused whoever declares it: the cross-site guard exempts
// GET and HEAD, so an action answering one would be a write with no protection
// at all. The refusal lives in session.Registry and so covers a kind that
// arrives from a manifest exactly as it covers one written in Go.
func TestAPluginCannotDeclareAnActionThatAnswersGET(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	kinds := session.NewRegistry()
	h := NewHost(s, HostConfig{})
	h.Kinds = kinds

	kind := kindName(t)
	in := installWithKinds(t, s, testOrgID, KindDef{
		Kind: kind, Display: "Retrospective",
		Actions: []ActionDef{{Name: "peek", Verb: http.MethodGet}},
	})
	err := h.OfferKinds(ctx, in.ID)
	if err == nil {
		t.Fatal("a plugin declared an action answering GET and it was registered")
	}
	if !strings.Contains(err.Error(), "cross-site guard") {
		t.Fatalf("the refusal is %q and does not say why", err)
	}
	if kinds.Known(kind) {
		t.Fatal("the kind was registered despite its refused action")
	}
}

func newOrg(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	installNo++
	slug := fmt.Sprintf("org-%d-%d", time.Now().UnixNano(), installNo)
	var id string
	if err := pool.QueryRow(context.Background(),
		"insert into orgs (slug, name, claim_value) values ($1, $1, $1) returning id::text", slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
