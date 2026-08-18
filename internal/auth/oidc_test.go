package auth

import (
	"strings"
	"testing"
)

func TestDisplayNamePrefersFriendliestClaim(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []string
		want string
	}{
		{"full name wins", []string{"Dana Whitlock", "dwhitlock", "dana@example.com", "sub-1"}, "Dana Whitlock"},
		{"falls back to username", []string{"", "dwhitlock", "dana@example.com", "sub-1"}, "dwhitlock"},
		{"email loses its domain", []string{"", "", "dana@example.com", "sub-1"}, "dana"},
		{"subject is the last resort", []string{"", "", "", "sub-1"}, "sub-1"},
		{"nothing at all still names someone", []string{"", "", "", ""}, "Someone"},
		// The users table caps names at 64 characters; a provider that sends a
		// longer one must not turn every sign-in into a failed insert.
		{"over-long names are cut to fit the column", []string{strings.Repeat("a", 100)}, strings.Repeat("a", 64)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := displayName(tc.in...); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
