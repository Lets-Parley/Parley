package plugin

import (
	"strings"
	"testing"
)

// The consent screen is only as honest as the agreement between what it says a
// grant permits and what the guard actually permits. These tests are that
// agreement, checked rather than promised.

func TestExplanationsMatchTheGuard(t *testing.T) {
	for _, pattern := range []string{
		"api.example.com",
		"*.example.com",
		"EXAMPLE.COM",
		"*.internal.example.org",
	} {
		e := ExplainAllowPattern(pattern)
		if len(e.Allows) == 0 || len(e.Refuses) == 0 {
			t.Fatalf("%q: the explanation carries no worked examples, so nothing pins it to the guard", pattern)
		}
		for _, host := range e.Allows {
			if !hostAllowed(host, []string{pattern}) {
				t.Errorf("%q: the screen tells an operator %s is permitted, and the guard refuses it", pattern, host)
			}
		}
		for _, host := range e.Refuses {
			if hostAllowed(host, []string{pattern}) {
				t.Errorf("%q: the screen tells an operator %s is refused, and the guard permits it", pattern, host)
			}
		}
	}
}

// A wildcard shown as itself is not consent. The summary has to name the set.
func TestAWildcardIsExpandedRatherThanEchoed(t *testing.T) {
	e := ExplainAllowPattern("*.example.com")
	if strings.Contains(e.Summary, "*") {
		t.Fatalf("the summary still contains the glyph an operator cannot read: %q", e.Summary)
	}
	if !strings.Contains(e.Summary, "subdomain") || !strings.Contains(e.Summary, "not example.com itself") {
		t.Fatalf("the summary does not say what the wildcard covers and what it leaves out: %q", e.Summary)
	}
}

// An entry the guard could never enforce must not read like a rule that
// matches something.
func TestAnUnenforceableEntrySaysSo(t *testing.T) {
	e := ExplainAllowPattern("api.*.example.com")
	if len(e.Allows) != 0 {
		t.Fatalf("an unenforceable entry was described as permitting %v", e.Allows)
	}
	if !strings.Contains(e.Summary, "matches nothing") {
		t.Fatalf("summary = %q, want it to say the entry matches nothing", e.Summary)
	}
}

// Every capability the host enforces must have consequence copy. A capability
// added later with no sentence would reach the consent screen as its own name,
// which is the failure this whole surface exists to prevent.
func TestEveryCapabilityIsDescribedByConsequence(t *testing.T) {
	for _, capability := range []string{
		CapabilityKV, CapabilityFetch, CapabilityLog, CapabilitySessionRead,
		CapabilitySessionPatch, CapabilityJobs, CapabilityEmit,
		CapabilityEvents, CapabilitySecrets,
	} {
		d := Describe(Grant{Capability: capability, Scope: "example.com"})
		if d.Permits == "" {
			t.Errorf("%s has no description at all", capability)
			continue
		}
		if strings.Contains(d.Permits, "does not recognise") {
			t.Errorf("%s falls through to the unknown-capability text", capability)
		}
		// The copy names a consequence, not the identifier. "Can send…",
		// "Can read…" — never a bare restating of the capability's name.
		if !strings.HasPrefix(d.Permits, "Can ") && !strings.HasPrefix(d.Permits, "Is ") {
			t.Errorf("%s reads as a label rather than a consequence: %q", capability, d.Permits)
		}
	}
}

func TestAnUnknownCapabilityIsRefusedInWords(t *testing.T) {
	d := Describe(Grant{Capability: "filesystem"})
	if !strings.Contains(d.Permits, "Do not grant it") {
		t.Fatalf("an unknown capability was described as %q; an operator must be told the host cannot explain it", d.Permits)
	}
}

// An unscoped grant covers everything, and the sentence has to say so.
//
// State.Allows treats an empty scope as "any", so session:read with no scope
// is read access to every session on the instance. Describing that with the
// same singular sentence a scoped grant gets — "the live state of a session" —
// understates by the whole width of the instance, and the wording *is* the
// security boundary here: it is the only thing the operator sees before they
// agree. The same goes for session:patch and secrets.
func TestAnUnscopedGrantSaysSoAndAScopedOneNamesIt(t *testing.T) {
	for _, tc := range []struct {
		capability string
		scope      string
	}{
		{CapabilitySessionRead, "room-42"},
		{CapabilitySessionPatch, "room-42"},
		{CapabilitySecrets, "stripe-key"},
	} {
		unscoped := Describe(Grant{Capability: tc.capability}).Permits
		scoped := Describe(Grant{Capability: tc.capability, Scope: tc.scope}).Permits

		if unscoped == scoped {
			t.Errorf("%s reads the same whether it covers one thing or every thing on the instance: %q",
				tc.capability, unscoped)
			continue
		}
		if !strings.Contains(unscoped, "every") {
			t.Errorf("the unscoped %s grant reads as %q and never says it covers everything",
				tc.capability, unscoped)
		}
		if !strings.Contains(scoped, tc.scope) {
			t.Errorf("the scoped %s grant reads as %q and does not name %q",
				tc.capability, scoped, tc.scope)
		}
		// A scoped grant must not borrow the unscoped alarm: an operator who
		// reads "every session" on a grant covering one has been told the
		// wrong thing in the other direction.
		if strings.Contains(scoped, "every session") || strings.Contains(scoped, "every secret") {
			t.Errorf("the scoped %s grant claims instance-wide reach: %q", tc.capability, scoped)
		}
	}
}
