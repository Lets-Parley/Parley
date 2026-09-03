package plugin

import (
	"fmt"
	"strings"
)

// Consent copy lives here, next to the guards that enforce it.
//
// The operator screen is the only place a human sees what a plugin is asking
// for before it gets it, so the wording is part of the security boundary. Two
// rules follow from that, and both are the reason this file is in the plugin
// package rather than in the web bundle:
//
//   - A grant is described by what it *permits in consequence*, not by what it
//     is called. "fetch: api.example.com" tells an operator nothing; "can send
//     anything it holds, including session data, to api.example.com" tells them
//     what they are agreeing to.
//   - A wildcard allowlist entry is expanded into worked examples produced from
//     hostAllowed itself, so the screen cannot drift away from the enforcement.
//     TestExplanationsMatchTheGuard asserts every example against hostAllowed.

// DescribedGrant is one grant as an operator reads it.
type DescribedGrant struct {
	Capability string `json:"capability"`
	Scope      string `json:"scope"`
	// Permits is the consequence sentence. Always populated; an unknown
	// capability gets the deliberately alarming fallback rather than silence.
	Permits string `json:"permits"`
	// Allows and Refuses are worked examples, presently only for fetch. They
	// are what makes a wildcard readable: a grant a human cannot read is not
	// consent.
	Allows  []string `json:"allows,omitempty"`
	Refuses []string `json:"refuses,omitempty"`
}

// Describe turns one grant into the sentence the consent screen shows.
func Describe(g Grant) DescribedGrant {
	out := DescribedGrant{Capability: g.Capability, Scope: g.Scope}
	switch g.Capability {
	case CapabilityFetch:
		e := ExplainAllowPattern(g.Scope)
		out.Permits = "Can send anything it holds — including session data it has read — to " + e.Summary + "."
		out.Allows, out.Refuses = e.Allows, e.Refuses
	case CapabilityKV:
		if g.Scope == "" {
			out.Permits = "Can store and read back data of its own on this server, under any key. It cannot see what another plugin stored."
		} else {
			out.Permits = fmt.Sprintf("Can store and read back data of its own on this server, under keys beginning %q. It cannot see what another plugin stored.", g.Scope)
		}
	case CapabilitySecrets:
		out.Permits = "Can store and read back secrets — API tokens, passwords — encrypted on this server. Combined with any outbound access below, it can send them."
	case CapabilityLog:
		out.Permits = "Can write lines into this server's log, where they sit alongside Parley's own."
	case CapabilitySessionRead:
		out.Permits = "Can read the live state of a session: who is seated, what has been voted, what has been written in a standup."
	case CapabilitySessionPatch:
		out.Permits = "Can change the live state of a session — move a room's phase, alter what is shown to everyone in it."
	case CapabilityJobs:
		out.Permits = "Can schedule its own work to run later on this server, outside any request a person made."
	case CapabilityEmit:
		out.Permits = "Can publish events of its own, which other plugins receive as though Parley had raised them."
	case CapabilityEvents:
		if g.Scope == "" {
			out.Permits = "Is sent a copy of every event Parley raises, payload included."
		} else {
			out.Permits = fmt.Sprintf("Is sent a copy of every %q event, payload included.", g.Scope)
		}
	default:
		// Unknown is not harmless. An operator must be told the host cannot
		// explain what they are about to agree to.
		out.Permits = fmt.Sprintf("Parley does not recognise the capability %q and cannot say what it permits. Do not grant it.", g.Capability)
	}
	return out
}

// DescribeAll describes a grant set in the order it was given.
func DescribeAll(grants []Grant) []DescribedGrant {
	out := make([]DescribedGrant, 0, len(grants))
	for _, g := range grants {
		out = append(out, Describe(g))
	}
	return out
}

// AllowExplanation is one fetch allowlist entry, expanded.
type AllowExplanation struct {
	Pattern string
	// Summary reads as the object of a sentence: "…send it to <Summary>".
	Summary string
	// Allows and Refuses are hosts the guard really would and really would
	// not permit. They are checked against hostAllowed by test, so the screen
	// cannot promise a rule the guard does not apply.
	Allows  []string
	Refuses []string
}

// ExplainAllowPattern expands one allowlist entry into something a human can
// consent to. A wildcard is never shown as itself: "*.example.com" is a rule
// about an unbounded set of hosts, and an operator agreeing to the glyph is
// not agreeing to the set.
func ExplainAllowPattern(pattern string) AllowExplanation {
	p := strings.ToLower(strings.TrimSpace(pattern))
	out := AllowExplanation{Pattern: pattern}
	if err := ValidateAllowPattern(p); err != nil {
		out.Summary = fmt.Sprintf("%q, which is not a host this instance can enforce — it matches nothing", pattern)
		return out
	}
	if base, ok := strings.CutPrefix(p, "*."); ok {
		out.Summary = "any subdomain of " + base + ", however deep — but not " + base + " itself"
		out.Allows = []string{"api." + base, "a.b." + base}
		out.Refuses = []string{base, base + ".example.invalid", "not" + base}
		return out
	}
	out.Summary = p + " and nothing else"
	out.Allows = []string{p}
	out.Refuses = []string{"sub." + p, p + ".example.invalid"}
	return out
}
