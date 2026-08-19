package dbtest

import "testing"

func TestDecide(t *testing.T) {
	for _, tc := range []struct {
		name, dsn, optOut string
		want              outcome
	}{
		{"a dsn is used", "postgres://x", "", useDSN},
		{"a dsn wins over the opt-out", "postgres://x", "1", useDSN},
		{"no dsn and no opt-out is a failure", "", "", failLoudly},
		{"the opt-out skips", "", "1", skipNoisily},
		{"any non-empty opt-out skips", "", "yes", skipNoisily},
	} {
		if got := decide(tc.dsn, tc.optOut); got != tc.want {
			t.Errorf("%s: decide(%q, %q) = %v, want %v", tc.name, tc.dsn, tc.optOut, got, tc.want)
		}
	}
}
