package plugin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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

// kindName is a kind name no other test — and no other *run* — will pick.
//
// session_kinds.kind is the primary key and a row outlives the process that
// wrote it: a run killed between the insert and t.Cleanup leaves the row
// behind for good. A clock-and-counter name lets that abandoned row be picked
// again, and it was: a leftover row carrying a GET-verb action failed a test
// deterministically on a git-clean checkout until somebody deleted it by hand.
// CI never sees it — the database is fresh every run — so the whole cost lands
// on whoever shares a local one. Random bytes make the repeat not happen.
func kindName(t *testing.T) string {
	t.Helper()
	return "retro-" + randomSuffix(t)
}

// randomSuffix is the same trick, as one function, for every durable name a
// test in this package writes.
func randomSuffix(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b[:])
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

// The room iframe needs the install's name, version and grants on the kind so
// BuildEnvelope can put them on the wire. A StateFunc that only returns
// ceremony state leaves SessionPage with no frame URL.
func TestPluginKindProjectsTheInstallOntoTheKind(t *testing.T) {
	h := NewHost(&Store{}, HostConfig{})
	kind := kindName(t)
	k := h.PluginKind(State{
		Install: Install{ID: "x", OrgID: testOrgID, Name: "retro", Version: "2.0.0"},
		Grants: []Grant{
			{Capability: CapabilitySessionRead},
			{Capability: CapabilitySessionRead, Scope: "ignored-dup"},
			{Capability: CapabilityLog},
		},
	}, KindDef{Kind: kind, Display: "Retrospective"})
	if k.Plugin == nil {
		t.Fatal("a plugin-provided kind carried no install for the room frame")
	}
	if k.Plugin.Name != "retro" || k.Plugin.Version != "2.0.0" {
		t.Fatalf("the install on the kind is %+v", k.Plugin)
	}
	got := strings.Join(k.Plugin.Grants, ",")
	if got != "log,session:read" {
		t.Fatalf("grants on the kind are %v, want log,session:read", k.Plugin.Grants)
	}
}

func pluginKindForCSV(t *testing.T) session.Kind {
	t.Helper()
	h := NewHost(&Store{}, HostConfig{})
	return h.PluginKind(State{
		Install: Install{ID: "x", OrgID: testOrgID, Name: "retro", Version: "1.0.0"},
	}, KindDef{Kind: kindName(t), Display: "Retrospective"})
}

// A plugin-provided ceremony has to export: the HTTP path maps a missing
// Kind.CSV to 404 "this session kind has no export", and Host.PluginKind
// used to leave CSV nil, so every plugin room answered that way.
func TestPluginKindHasCSV(t *testing.T) {
	if pluginKindForCSV(t).CSV == nil {
		t.Fatal("a plugin-provided kind has no CSV exporter")
	}
}

func TestCSVRowsSucceedsForARegisteredPluginKind(t *testing.T) {
	k := pluginKindForCSV(t)
	r := session.NewRegistry()
	if err := r.Register(k); err != nil {
		t.Fatal(err)
	}
	rows, err := r.CSVRows(session.Envelope{
		ID: "s1", Kind: k.Name, Title: "Retro", Phase: "open",
		State: map[string]any{"note": "hello"},
	})
	if err != nil {
		t.Fatalf("CSVRows for a registered plugin kind: %v", err)
	}
	if len(rows) < 2 {
		t.Fatalf("plugin CSV = %v, want a header and a data row", rows)
	}
	found := false
	for i, h := range rows[0] {
		if h == "note" && rows[1][i] == "hello" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("plugin CSV missing the wire state's note=hello: %v", rows)
	}
}

func TestPluginCSVSanitizesAFormulaCell(t *testing.T) {
	k := pluginKindForCSV(t)
	if k.CSV == nil {
		t.Fatal("a plugin-provided kind has no CSV exporter")
	}
	rows, err := k.CSV(session.Envelope{
		ID: "s1", Kind: k.Name, Title: "Retro", Phase: "open",
		State: json.RawMessage(`{"note":"=HYPERLINK"}`),
	})
	if err != nil {
		t.Fatalf("plugin CSV: %v", err)
	}
	found := false
	for _, row := range rows {
		for _, cell := range row {
			if cell == "'=HYPERLINK" {
				found = true
			}
			if cell == "=HYPERLINK" {
				t.Fatalf("plugin CSV left a formula cell unsanitized: %v", rows)
			}
		}
	}
	if !found {
		t.Fatalf("plugin CSV missing the sanitized formula cell: %v", rows)
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

// Two orgs may run plugins of the same name, so the kind name — which is
// instance-wide, because sessions.kind is a foreign key to it — is the thing
// they can collide on. The second org is refused rather than quietly taking
// over the first org's rooms.
//
// The provider name is deliberately identical on both sides. seedKinds' upsert
// predicate ANDs the provider with the org, so a rival install with a
// *different* provider name is refused by the provider half alone and proves
// nothing about the org half: delete the org predicate and such a test stays
// green. This is the variant where the org is the only thing that differs, and
// so the only thing that can be doing the refusing.
func TestTwoOrgsRunningTheSamePluginNameDoNotShareAKind(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	kind := kindName(t)
	installNo++
	name := fmt.Sprintf("plug-%d-%d", time.Now().UnixNano(), installNo)
	t.Cleanup(func() { _, _ = pool.Exec(ctx, "delete from session_kinds where kind = $1", kind) })

	if _, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: name, Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: kind, Display: "Retrospective"}},
	}); err != nil {
		t.Fatalf("the first org installing its own ceremony: %v", err)
	}

	other := newOrg(t, pool)
	_, err := s.Install(ctx, InstallRequest{
		OrgID: other, Name: name, Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: kind, Display: "Mine Now"}},
	})
	if !errors.Is(err, ErrKindTaken) {
		t.Fatalf("a same-named plugin in another org claiming the kind: got %v, want ErrKindTaken", err)
	}
	var owner, display string
	if err := pool.QueryRow(ctx,
		"select org_id::text, display from session_kinds where kind = $1", kind).Scan(&owner, &display); err != nil {
		t.Fatal(err)
	}
	if owner != testOrgID {
		t.Fatalf("the kind now belongs to %s, want the org that installed it", owner)
	}
	if display != "Retrospective" {
		t.Fatalf("display = %q: the rival install overwrote the owning org's row", display)
	}
}

// The mirror of the test above, and the half it cannot see.
//
// seedKinds' upsert predicate ANDs the provider with the org, so a test whose
// two installs differ in *both* is refused by either half alone and says
// nothing about which one did it. Both existing tests are that shape. Here the
// org is identical and only the provider name differs, so the provider
// predicate is the only thing that can be doing the refusing: delete it and
// this goes red while both of those stay green.
//
// What it stops is not hypothetical. Without the provider half, installing a
// second plugin in an org that already runs one takes over that plugin's kind
// row — overwriting its display and its whole dispatch table, clearing the
// retirement, and moving the kind to the hijacker as far as ProvidedKinds is
// concerned, with every room already created against it still pointing there.
func TestAnInstallCannotTakeOverAKindItsOwnOrgAlreadyProvides(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	kind := kindName(t)
	t.Cleanup(func() { _, _ = pool.Exec(ctx, "delete from session_kinds where kind = $1", kind) })

	alpha := "alpha-" + randomSuffix(t)
	if _, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: alpha, Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: kind, Display: "Retrospective",
			Actions: []ActionDef{{Name: "gather", Verb: http.MethodPost}}}},
	}); err != nil {
		t.Fatalf("the first plugin installing its own ceremony: %v", err)
	}

	// A second plugin, in the very same org, declaring the same kind name.
	_, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: "beta-" + randomSuffix(t), Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: kind, Display: "Mine Now",
			Actions: []ActionDef{{Name: "seize", Verb: http.MethodDelete}}}},
	})
	if !errors.Is(err, ErrKindTaken) {
		t.Fatalf("a sibling plugin in the same org claiming the kind: got %v, want ErrKindTaken", err)
	}

	var provider, display string
	var actions []byte
	var retired *time.Time
	if err := pool.QueryRow(ctx,
		"select provider, display, actions, retired_at from session_kinds where kind = $1",
		kind).Scan(&provider, &display, &actions, &retired); err != nil {
		t.Fatal(err)
	}
	if provider != alpha {
		t.Fatalf("the kind now names %q as its provider, want the plugin that installed it", provider)
	}
	if display != "Retrospective" {
		t.Fatalf("display = %q: the sibling install overwrote the owning plugin's row", display)
	}
	if !strings.Contains(string(actions), `"gather"`) || strings.Contains(string(actions), `"seize"`) {
		t.Fatalf("actions = %s: the sibling install overwrote the owning plugin's dispatch table", actions)
	}
	if retired != nil {
		t.Fatalf("retired_at = %v, want the refused install to have left it alone", retired)
	}
}

// ProvidesKind is the ownership half of the plugin session surface's boundary,
// and it answers for the install as it is *now*. A switched-off install and a
// retired kind both provide nothing: the sibling reads (ProvidedKinds,
// Sessions.OfferableKinds) already say so, and a boundary that disagreed with
// them would be relying on the enabled check that happens to sit two layers up
// in the host function.
func TestASwitchedOffInstallAndARetiredKindProvideNothing(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	kind := kindName(t)
	in := installWithKinds(t, s, testOrgID, KindDef{Kind: kind, Display: "Retrospective"})

	ok, err := s.ProvidesKind(ctx, in.ID, kind)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("an enabled install does not provide its own live kind, so the rest of this proves nothing")
	}

	if err := s.SetEnabled(ctx, in.ID, false); err != nil {
		t.Fatal(err)
	}
	ok, err = s.ProvidesKind(ctx, in.ID, kind)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a switched-off install still provides its kind")
	}

	if err := s.SetEnabled(ctx, in.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "update session_kinds set retired_at = now() where kind = $1", kind); err != nil {
		t.Fatal(err)
	}
	ok, err = s.ProvidesKind(ctx, in.ID, kind)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a retired kind is still provided by the install that used to offer it")
	}
}

// Two kinds in one manifest are the same kind when their *names* match, and
// the name is the only field that decides it. The screen is a map lookup and a
// map lookup keyed on the wrong field is invisible to any fixture whose two
// declarations differ in every field at once — so both directions are here:
// one name twice is refused, and one display name twice is not.
func TestDuplicateDetectionComparesTheKindNameAndNotTheDisplayName(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()

	// Same kind, different display: a duplicate, and refused.
	kind := kindName(t)
	_, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: "dup-" + randomSuffix(t), Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{
			{Kind: kind, Display: "Retrospective"},
			{Kind: kind, Display: "Something Else Entirely"},
		},
	})
	if !errors.Is(err, ErrBadKindDef) {
		t.Fatalf("one kind name declared twice: got %v, want ErrBadKindDef", err)
	}

	// Different kinds, same display: not a duplicate. A display name is a
	// label, not an identity, and two ceremonies of a plugin may well be
	// called the same thing in two languages of one manifest.
	first, second := kindName(t), kindName(t)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "delete from session_kinds where kind = any($1)", []string{first, second})
	})
	if _, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: "twin-" + randomSuffix(t), Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{
			{Kind: first, Display: "Retrospective"},
			{Kind: second, Display: "Retrospective"},
		},
	}); err != nil {
		t.Fatalf("two kinds sharing a display name: got %v, want them accepted", err)
	}
	var kinds int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_kinds where kind = any($1)", []string{first, second}).Scan(&kinds); err != nil {
		t.Fatal(err)
	}
	if kinds != 2 {
		t.Fatalf("%d of the two same-named ceremonies were recorded, want both", kinds)
	}
}

// And the same sentence one level down: two actions of one kind are the same
// action when their names match. An unscreened duplicate is a dispatch table
// with one entry silently winning, so the manifest is refused instead.
func TestAKindDeclaringOneActionNameTwiceIsRefused(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	kind := kindName(t)

	_, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: "dupact-" + randomSuffix(t), Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: kind, Display: "Retrospective", Actions: []ActionDef{
			{Name: "gather", Verb: http.MethodPost},
			{Name: "gather", Verb: http.MethodDelete},
		}}},
	})
	if !errors.Is(err, ErrBadKindDef) {
		t.Fatalf("one action name declared twice: got %v, want ErrBadKindDef", err)
	}
	var rows int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_kinds where kind = $1", kind).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatal("a refused manifest left a session kind behind")
	}

	// Two different action names on one kind are of course fine, which is what
	// says the refusal above is about the repeat and not about having two.
	good := kindName(t)
	t.Cleanup(func() { _, _ = pool.Exec(ctx, "delete from session_kinds where kind = $1", good) })
	if _, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: "twoact-" + randomSuffix(t), Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: good, Display: "Retrospective", Actions: []ActionDef{
			{Name: "gather", Verb: http.MethodPost},
			{Name: "close", Verb: http.MethodPost},
		}}},
	}); err != nil {
		t.Fatalf("a kind with two differently-named actions: got %v, want it accepted", err)
	}
}

// A manifest is untrusted, and a declaration the host will not honour is
// refused at install rather than at enable. The verb is the case that matters
// most: it is upper-cased before it is screened, because a manifest writing
// "get" used to pass session.Registry's comparison against http.MethodGet and
// then never match the dispatcher's exact comparison either — an action that
// installed, enabled and could never be called.
func TestAManifestDeclaringAKindTheHostWillNotHonourIsRefusedAtInstall(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	good := kindName(t)

	for _, tc := range []struct {
		name string
		def  KindDef
	}{
		{"an empty kind name", KindDef{Kind: "", Display: "Retrospective"}},
		{"a kind name with a path segment in it", KindDef{Kind: "retro/../poker", Display: "Retrospective"}},
		{"a kind name shouting in capitals", KindDef{Kind: "Retro", Display: "Retrospective"}},
		{"a kind name longer than the column", KindDef{Kind: strings.Repeat("a", 65), Display: "Retrospective"}},
		{"an empty display name", KindDef{Kind: good, Display: ""}},
		{"a display name longer than the column", KindDef{Kind: good, Display: strings.Repeat("a", 65)}},
		{"a lower-case get, which reads as a verb the registry would refuse", KindDef{
			Kind: good, Display: "Retrospective",
			Actions: []ActionDef{{Name: "peek", Verb: "get"}}}},
		{"a verb that is not a verb", KindDef{
			Kind: good, Display: "Retrospective",
			Actions: []ActionDef{{Name: "gather", Verb: "YOINK"}}}},
		{"an empty action name", KindDef{
			Kind: good, Display: "Retrospective",
			Actions: []ActionDef{{Name: "", Verb: http.MethodPost}}}},
		{"the same kind twice", KindDef{Kind: good, Display: "Retrospective"}},
	} {
		defs := []KindDef{tc.def}
		if tc.name == "the same kind twice" {
			defs = append(defs, tc.def)
		}
		installNo++
		name := fmt.Sprintf("plug-%d-%d", time.Now().UnixNano(), installNo)
		_, err := s.Install(ctx, InstallRequest{
			OrgID: testOrgID, Name: name, Version: "1.0.0", QuotaBytes: 1024, Kinds: defs,
		})
		if !errors.Is(err, ErrBadKindDef) {
			t.Errorf("%s: got %v, want ErrBadKindDef", tc.name, err)
		}
		// Nothing at all was written: the screen runs before the transaction.
		var installs int
		if err := pool.QueryRow(ctx,
			"select count(*) from plugin_installs where name = $1", name).Scan(&installs); err != nil {
			t.Fatal(err)
		}
		if installs != 0 {
			t.Errorf("%s: a refused manifest left an install behind", tc.name)
		}
	}

	// And a well-formed manifest whose verb merely needs canonicalising is
	// accepted, with the canonical form stored — so the screen is a
	// normalisation and not only a refusal.
	kind := kindName(t)
	in := installWithKinds(t, s, testOrgID, KindDef{
		Kind: kind, Display: "Retrospective",
		Actions: []ActionDef{{Name: "gather", Verb: "post"}},
	})
	defs, err := s.ProvidedKinds(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(defs) != 1 || len(defs[0].Actions) != 1 || defs[0].Actions[0].Verb != http.MethodPost {
		t.Fatalf("the stored actions are %+v, want the verb canonicalised to POST", defs)
	}
}

// A GET action is refused whoever declares it: the cross-site guard exempts
// GET and HEAD, so an action answering one would be a write with no protection
// at all. There are two layers and both matter — the install screen refuses the
// manifest, and session.Registry refuses the registration for a kind that
// somehow reached it anyway.
func TestAPluginCannotDeclareAnActionThatAnswersGET(t *testing.T) {
	pool := testPool(t)
	s := &Store{Pool: pool}
	ctx := context.Background()
	kinds := session.NewRegistry()
	h := NewHost(s, HostConfig{})
	h.Kinds = kinds

	kind := kindName(t)
	installNo++
	name := fmt.Sprintf("plug-%d-%d", time.Now().UnixNano(), installNo)
	_, err := s.Install(ctx, InstallRequest{
		OrgID: testOrgID, Name: name, Version: "1.0.0", QuotaBytes: 1024,
		Kinds: []KindDef{{Kind: kind, Display: "Retrospective",
			Actions: []ActionDef{{Name: "peek", Verb: http.MethodGet}}}},
	})
	if !errors.Is(err, ErrBadKindDef) {
		t.Fatalf("installing a manifest with a GET action: got %v, want ErrBadKindDef", err)
	}

	// The registry's own refusal, which is the layer that covers a kind
	// written in Go as well as one that arrived from a manifest.
	err = kinds.Register(h.PluginKind(State{Install: Install{ID: "x", OrgID: testOrgID}}, KindDef{
		Kind: kind, Display: "Retrospective",
		Actions: []ActionDef{{Name: "peek", Verb: http.MethodGet}},
	}))
	if err == nil {
		t.Fatal("a kind with an action answering GET was registered")
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
