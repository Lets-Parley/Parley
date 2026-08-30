package session

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testConfig stands in for a real kind's config document. Registering a kind
// here keeps the test independent of poker and standup, which import this
// package.
type testConfig struct {
	Deck    string `json:"deck"`
	Seconds int    `json:"seconds"`
}

// testKind returns a throwaway kind. Every test builds its own Registry, so
// nothing here touches state another test can see.
func testKind() Kind {
	return Kind{
		Name:      "kindtest",
		NewConfig: func() any { return &testConfig{} },
	}
}

// registryWith builds a Registry holding the given kinds, failing the test if
// any of them is rejected.
func registryWith(t *testing.T, kinds ...Kind) *Registry {
	t.Helper()
	r := NewRegistry()
	for _, k := range kinds {
		if err := r.Register(k); err != nil {
			t.Fatalf("Register(%q): %v", k.Name, err)
		}
	}
	return r
}

func TestKnown(t *testing.T) {
	r := registryWith(t, testKind())
	if !r.Known("kindtest") {
		t.Fatal("Known reports a registered kind as unknown")
	}
	for _, kind := range []string{"", "KINDTEST", "nope"} {
		if r.Known(kind) {
			t.Errorf("Known(%q) = true, want false", kind)
		}
	}
}

func TestRegisterRejectsDuplicates(t *testing.T) {
	// Two packages claiming the same kind is a wiring mistake. Silently
	// overwriting turns it into a phantom config at runtime, so it has to be
	// an error at registration time instead.
	r := registryWith(t, testKind())
	if err := r.Register(testKind()); err == nil {
		t.Fatal("Register accepted a duplicate kind")
	}
	if _, err := r.ParseConfig("kindtest", []byte(`{"deck":"fibonacci"}`)); err != nil {
		t.Fatalf("the first registration no longer parses its own config: %v", err)
	}
}

func TestRegisterRejectsAnEmptyName(t *testing.T) {
	k := testKind()
	k.Name = ""
	if err := NewRegistry().Register(k); err == nil {
		t.Fatal("Register accepted a kind with no name")
	}
}

func TestUnregister(t *testing.T) {
	r := registryWith(t, testKind())
	if err := r.Unregister("kindtest"); err != nil {
		t.Fatalf("Unregister: %v", err)
	}
	if r.Known("kindtest") {
		t.Fatal("the kind is still known after Unregister")
	}
	if err := r.Unregister("kindtest"); err == nil {
		t.Fatal("Unregister accepted a kind that is not registered")
	}
	// The name is free again once removed.
	if err := r.Register(testKind()); err != nil {
		t.Fatalf("re-registering an unregistered kind: %v", err)
	}
}

func TestParseConfigRejectsUnknownKind(t *testing.T) {
	if _, err := NewRegistry().ParseConfig("no-such-kind", []byte(`{}`)); err == nil {
		t.Fatal("ParseConfig accepted an unregistered kind")
	}
}

func TestParseConfigFillsDefaultsForEmptyInput(t *testing.T) {
	r := registryWith(t, testKind())
	// A session created without a config body must still store a valid
	// document, not a null the state builders would have to guard against.
	for _, raw := range [][]byte{nil, {}, []byte(`{}`)} {
		out, err := r.ParseConfig("kindtest", raw)
		if err != nil {
			t.Fatalf("ParseConfig(%q): %v", raw, err)
		}
		var got testConfig
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("output is not valid JSON: %v", err)
		}
		if got != (testConfig{}) {
			t.Errorf("ParseConfig(%q) = %s, want the zero config", raw, out)
		}
	}
}

func TestParseConfigRejectsBadDocuments(t *testing.T) {
	r := registryWith(t, testKind())
	for name, raw := range map[string]string{
		"unknown field":  `{"deck":"fib","sneaky":true}`,
		"wrong type":     `{"seconds":"ninety"}`,
		"not an object":  `["deck"]`,
		"malformed json": `{"deck":`,
		"bare string":    `"fib"`,
	} {
		if out, err := r.ParseConfig("kindtest", []byte(raw)); err == nil {
			t.Errorf("%s: ParseConfig(%s) returned %s, want an error", name, raw, out)
		}
	}
}

func TestParseConfigNormalizesOutput(t *testing.T) {
	r := registryWith(t, testKind())
	// Whatever the client sent, what gets stored is a re-marshalled struct:
	// key order is the struct's and nothing outside it survives.
	out, err := r.ParseConfig("kindtest", []byte(`{"seconds": 90, "deck":  "fibonacci"}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"deck":"fibonacci","seconds":90}`; string(out) != want {
		t.Fatalf("ParseConfig = %s, want %s", out, want)
	}
}

func TestParseConfigRejectsTrailingDocuments(t *testing.T) {
	r := registryWith(t, testKind())
	// The decoder reads one value. A second document appended to the body must
	// be an error rather than a silent truncation, so the dropped half can
	// never smuggle a field past the first document's validation.
	for _, raw := range []string{
		`{"deck":"fibonacci"} {"deck":"evil"}`,
		`{"deck":"fibonacci"} garbage`,
		`{"deck":"fibonacci"}{}`,
	} {
		if out, err := r.ParseConfig("kindtest", []byte(raw)); err == nil {
			t.Errorf("ParseConfig(%s) = %s, want an error", raw, out)
		}
	}
}

func TestCSVRows(t *testing.T) {
	k := testKind()
	k.CSV = func(env Envelope) ([][]string, error) {
		return [][]string{{env.ID}}, nil
	}
	r := registryWith(t, k)

	rows, err := r.CSVRows(Envelope{ID: "s1", Kind: "kindtest"})
	if err != nil {
		t.Fatalf("CSVRows: %v", err)
	}
	if len(rows) != 1 || rows[0][0] != "s1" {
		t.Fatalf("CSVRows = %v, want [[s1]]", rows)
	}
	if _, err := r.CSVRows(Envelope{Kind: "nope"}); err == nil {
		t.Error("CSVRows accepted an unregistered kind")
	}
	// A kind may register without an exporter; asking for its rows is an
	// error, not a nil-function panic.
	noCSV := registryWith(t, testKind())
	if _, err := noCSV.CSVRows(Envelope{Kind: "kindtest"}); err == nil {
		t.Error("CSVRows accepted a kind with no exporter")
	}
}

func TestRegisterRefusesAnActionThatAnswersGET(t *testing.T) {
	r := NewRegistry()
	err := r.Register(Kind{
		Name: "peek",
		Actions: map[string]Action{
			"read": {Verb: http.MethodGet, Do: func(http.ResponseWriter, *http.Request, ActionCtx) {}},
		},
	})
	if err == nil {
		t.Fatal("registering a GET action succeeded; it would be a write with no cross-site protection")
	}
	if r.Known("peek") {
		t.Fatal("the kind was registered anyway")
	}
}

// TestStateFuncTakesTheConcretePool pins a decision, not a mechanism.
//
// Issue #143 asked whether StateFunc should shed *pgxpool.Pool for a narrow
// SessionReader interface. It should not, and the reasoning is written down in
// the add-a-session-kind checklist in
// site/src/content/docs/project/contributing.mdx. In short: every existing
// state builder issues arbitrary SQL — poker joins stories to votes and
// aggregates, standup reads sessions and standup_entries — so the interface
// would have to expose Query and QueryRow, which still hands a kind author
// pgx.Rows and pgx.Row. It would rename the dependency rather than remove it,
// and faking it well enough to be worth trusting means reimplementing pgx.Rows.
//
// This test exists so that narrowing the signature is a deliberate act that
// revisits the recorded reasoning, rather than a drive-by refactor.
func TestStateFuncTakesTheConcretePool(t *testing.T) {
	ft := reflect.TypeOf(StateFunc(nil))
	if got, want := ft.NumIn(), 3; got != want {
		t.Fatalf("StateFunc takes %d parameters, want %d", got, want)
	}
	if got, want := ft.In(1), reflect.TypeOf((*pgxpool.Pool)(nil)); got != want {
		t.Fatalf("StateFunc's second parameter is %s, want %s — see the add-a-session-kind checklist before changing this", got, want)
	}
}

// TestRedactForGuest calls RedactForGuest directly on a hand-built envelope,
// decoupled from websocket presence timing. That timing is exactly what let a
// wrong selfID argument at the ws.go call site pass the full API suite: every
// test that opens a guest websocket also registers that guest's presence
// through the socket, so the guest was already in the union via the presence
// branch, and the selfID argument itself was never independently exercised.
func TestRedactForGuest(t *testing.T) {
	// A fresh envelope per subtest: RedactForGuest documents a value-receiver
	// copy, but a mutation that broke that guarantee (e.g. a pointer receiver)
	// would otherwise leak a mutated base into later subtests and mask itself
	// — sharing one envelope across subtests defeats the very test meant to
	// pin the copy behaviour.
	newBase := func() Envelope {
		return Envelope{
			FacilitatorID: "fac-1",
			Presence:      []string{"present-1"},
			SpaceSlug:     "acme",
			Participants: []Person{
				{UserID: "fac-1", Name: "Facilitator"},
				{UserID: "present-1", Name: "Present"},
				{UserID: "self-1", Name: "Self"},
				{UserID: "absent-1", Name: "Absent Member"},
				{UserID: "", Name: "Empty ID"},
			},
		}
	}

	t.Run("selfID is kept even though absent from presence and not the facilitator", func(t *testing.T) {
		base := newBase()
		got := base.RedactForGuest("self-1")
		if !hasParticipant(got, "self-1") {
			t.Fatalf("RedactForGuest(%q) dropped the self participant; participants = %v", "self-1", got.Participants)
		}
	})

	t.Run("empty selfID matches nobody, including a participant with an empty UserID", func(t *testing.T) {
		base := newBase()
		got := base.RedactForGuest("")
		if hasParticipant(got, "") {
			t.Fatal(`RedactForGuest("") kept a participant with an empty UserID; the "" guard must not match it`)
		}
	})

	t.Run("presence and facilitator still govern everyone else", func(t *testing.T) {
		base := newBase()
		got := base.RedactForGuest("self-1")
		if !hasParticipant(got, "fac-1") {
			t.Fatal("RedactForGuest dropped the facilitator")
		}
		if !hasParticipant(got, "present-1") {
			t.Fatal("RedactForGuest dropped a present participant")
		}
		if hasParticipant(got, "absent-1") {
			t.Fatal("RedactForGuest kept a space member who is not present, not the facilitator, and not self — this is the privacy guarantee the feature exists for")
		}
	})

	t.Run("the receiver is a copy: the caller's envelope is unmutated", func(t *testing.T) {
		base := newBase()
		wantSlug := base.SpaceSlug
		wantParticipants := append([]Person(nil), base.Participants...)

		_ = base.RedactForGuest("self-1")

		if base.SpaceSlug != wantSlug {
			t.Fatalf("caller's SpaceSlug changed to %q after RedactForGuest, want %q", base.SpaceSlug, wantSlug)
		}
		if !reflect.DeepEqual(base.Participants, wantParticipants) {
			t.Fatalf("caller's Participants changed after RedactForGuest: got %v, want %v", base.Participants, wantParticipants)
		}
	})
}

func hasParticipant(e Envelope, userID string) bool {
	for _, p := range e.Participants {
		if p.UserID == userID {
			return true
		}
	}
	return false
}

type validatedConfig struct {
	N int `json:"n"`
}

func (c *validatedConfig) Validate() error {
	if c.N > 3 {
		return errors.New("n is too big")
	}
	return nil
}

// A kind whose config validates itself gets that validation on the way in —
// ParseConfig is the only gate between a space member and a stored config.
func TestParseConfigRunsValidate(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(Kind{Name: "validated", NewConfig: func() any { return &validatedConfig{} }}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ParseConfig("validated", []byte(`{"n":1}`)); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	if _, err := r.ParseConfig("validated", []byte(`{"n":9}`)); err == nil {
		t.Fatal("invalid config accepted")
	}
}
