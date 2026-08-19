package dbtest

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestDecide(t *testing.T) {
	for _, tc := range []struct {
		name, dsn, optOut string
		want              outcome
	}{
		{"a dsn is used", "postgres://x", "", useDSN},
		{"a dsn wins over the opt-out", "postgres://x", "1", useDSN},
		{"a whitespace-only dsn is no dsn", "   \t\n ", "", failLoudly},
		{"no dsn and no opt-out is a failure", "", "", failLoudly},
		{"the opt-out skips", "", "1", skipNoisily},
		{"true opts out", "", "true", skipNoisily},
		{"case does not matter", "", "YES", skipNoisily},
		{"surrounding space does not matter", "", " on ", skipNoisily},
		{"zero does not opt out", "", "0", failLoudly},
		{"false does not opt out", "", "false", failLoudly},
		{"no does not opt out", "", "No", failLoudly},
		{"an unrecognised value is a failure", "", "maybe", failBadOptOut},
		{"a typo is a failure, not an opt-out", "", "ture", failBadOptOut},
	} {
		if got := decide(tc.dsn, tc.optOut); got != tc.want {
			t.Errorf("%s: decide(%q, %q) = %v, want %v", tc.name, tc.dsn, tc.optOut, got, tc.want)
		}
	}
}

// envSubprocess names the case this process must play when it is a child of
// TestDSN. decide is pure and cheap to test directly, but DSN's fatal, skip and
// return branches are only observable from outside a test process, so the
// parent re-executes this binary once per case and reads back the exit status
// and output.
const envSubprocess = "PARLEY_DBTEST_SUBPROCESS_CASE"

func TestDSN(t *testing.T) {
	if c := os.Getenv(envSubprocess); c != "" {
		runSubprocessCase(t, c)
		return
	}

	for _, tc := range []struct {
		name    string
		dsn     string
		optOut  string
		wantOK  bool
		wantOut []string
	}{
		{
			name:    "no dsn and no opt-out fails and names what to set",
			wantOut: []string{EnvDSN + " is not set", EnvOptOut + "=1", "FAIL"},
		},
		{
			name:    "the opt-out skips and warns",
			optOut:  "1",
			wantOK:  true,
			wantOut: []string{"--- SKIP", "did NOT run", EnvOptOut + " set"},
		},
		{
			name:    "a false opt-out does not skip",
			optOut:  "0",
			wantOut: []string{EnvDSN + " is not set", "FAIL"},
		},
		{
			name:    "an unrecognised opt-out fails loudly",
			optOut:  "maybe",
			wantOut: []string{EnvOptOut + `="maybe" is not a recognised value`, "FAIL"},
		},
		{
			name:    "a dsn is returned, trimmed",
			dsn:     "  postgres://test:test@localhost:5432/test\n",
			wantOK:  true,
			wantOut: []string{"--- PASS"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := reexec(t, tc.name, tc.dsn, tc.optOut)
			if ok := err == nil; ok != tc.wantOK {
				t.Errorf("subprocess exited with err=%v, want ok=%v\n%s", err, tc.wantOK, out)
			}
			for _, want := range tc.wantOut {
				if !strings.Contains(out, want) {
					t.Errorf("subprocess output does not contain %q:\n%s", want, out)
				}
			}
		})
	}
}

// reexec runs this test binary again with only TestDSN selected and the
// environment the case describes.
func reexec(t *testing.T, name, dsn, optOut string) (string, error) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestDSN$", "-test.v", "-test.count=1")
	cmd.Env = append(os.Environ(),
		envSubprocess+"="+name,
		EnvDSN+"="+dsn,
		EnvOptOut+"="+optOut,
	)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// runSubprocessCase is the child half: it calls DSN for real so the parent can
// observe which branch ran.
func runSubprocessCase(t *testing.T, name string) {
	got := DSN(t) // every case but the last fails or skips the child outright
	if want := strings.TrimSpace(os.Getenv(EnvDSN)); got != want {
		t.Fatalf("%s: DSN returned %q, want the trimmed %q", name, got, want)
	}
}
