package poker

import (
	"strings"
	"testing"
)

func TestStoryIdentityError(t *testing.T) {
	cases := []struct {
		name, title, ref string
		want             string
	}{
		{name: "ref only", ref: "PAR-142"},
		{name: "title only", title: "Rate limiting"},
		{name: "both", title: "Rate limiting", ref: "PAR-142"},
		{name: "neither", want: "a ticket needs a reference or a title"},
		// Whitespace is not a name. The helper says so itself rather than
		// trusting that every caller trimmed on the way in.
		{name: "blank space", title: "   ", ref: "\t\n ", want: "a ticket needs a reference or a title"},
		{name: "padded ref only", ref: "  PAR-142  "},
		{name: "title too long", title: string(make([]byte, 201)), want: "a title can be at most 200 characters"},
		{name: "ref too long", ref: string(make([]byte, 41)), want: "a ticket reference can be at most 40 characters"},
		// Character limits, not byte limits — a full-length multi-byte value
		// must clear, and one character past must not.
		{name: "title at multi-byte limit", title: strings.Repeat("い", 200)},
		{name: "ref at multi-byte limit", ref: strings.Repeat("あ", 40)},
		{name: "title over multi-byte limit", title: strings.Repeat("い", 201), want: "a title can be at most 200 characters"},
		{name: "ref over multi-byte limit", ref: strings.Repeat("あ", 41), want: "a ticket reference can be at most 40 characters"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := storyIdentityError(c.title, c.ref); got != c.want {
				t.Fatalf("storyIdentityError(%q, %q) = %q, want %q", c.title, c.ref, got, c.want)
			}
		})
	}
}
