// Package dbtest resolves the database every database-backed test needs.
//
// A missing database is a failure, not a skip: `go test ./...` printing "ok"
// for a run where nothing touched Postgres is the worst outcome available.
// Local work that genuinely has no database can set PARLEY_SKIP_DB_TESTS=1, and
// pays for it with a warning naming every package it silenced.
package dbtest

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// EnvDSN is the connection string every database-backed test reads.
const EnvDSN = "TEST_DATABASE_URL"

// EnvOptOut downgrades the missing-database failure to a loud skip. It is
// parsed strictly: only 1/true/yes/y/on opt out, only 0/false/no/n/off (and
// unset) do not, and anything else is a hard failure. A typo must never be
// mistaken for consent to silence two thirds of the suite. CI asserts it is
// unset.
const EnvOptOut = "PARLEY_SKIP_DB_TESTS"

type outcome int

const (
	useDSN outcome = iota
	skipNoisily
	failLoudly
	failBadOptOut
)

// optOutValues is the whole vocabulary of EnvOptOut. Anything outside it is a
// failure, not a guess.
var optOutValues = map[string]bool{
	"1": true, "true": true, "yes": true, "y": true, "on": true,
	"0": false, "false": false, "no": false, "n": false, "off": false,
}

func decide(dsn, optOut string) outcome {
	if strings.TrimSpace(dsn) != "" {
		return useDSN
	}
	optOut = strings.TrimSpace(optOut)
	if optOut == "" {
		return failLoudly
	}
	skip, known := optOutValues[strings.ToLower(optOut)]
	switch {
	case !known:
		return failBadOptOut
	case skip:
		return skipNoisily
	default:
		return failLoudly
	}
}

var warnOnce sync.Once

// DSN returns the test database connection string. It fails the test when no
// database is configured, and skips only under the explicit opt-out.
func DSN(t *testing.T) string {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv(EnvDSN))
	optOut := os.Getenv(EnvOptOut)
	switch decide(dsn, optOut) {
	case useDSN:
		return dsn
	case skipNoisily:
		pkg := callerPackage()
		warnOnce.Do(func() { warn(pkg) })
		t.Skipf("%s set; skipping database-backed test", EnvOptOut)
	case failBadOptOut:
		t.Fatalf("%s=%q is not a recognised value: set %s=1 to skip database-backed tests, "+
			"or unset it to run them. It is parsed strictly so that a typo cannot quietly "+
			"silence most of the suite.", EnvOptOut, optOut, EnvOptOut)
	default:
		t.Fatalf("%s is not set: this test needs a database. Set %s=postgres://test:test@localhost:5432/test, "+
			"or set %s=1 to skip database-backed tests locally.", EnvDSN, EnvDSN, EnvOptOut)
	}
	return ""
}

// warn shouts about a silenced package everywhere it can be heard.
//
// `go test` throws away everything a *passing* package printed, on both stdout
// and stderr, so a banner written from inside the test process is invisible in
// a plain non-verbose run — precisely the run this warning exists for. Two
// writers between them cover the cases that matter:
//
//   - /dev/tty, when there is a terminal, bypasses `go test` entirely, so an
//     interactive `go test ./...` shows the banner.
//   - stderr is surfaced verbatim by `go test -v` and by `go test -json` (what
//     CI runs), which covers the non-interactive runs that read their own
//     output.
//
// A plain non-verbose run with no terminal — a script piping `go test ./...`
// into a file — genuinely cannot be warned from in here. CONTRIBUTING.md says
// so plainly rather than leaving a fallback that pretends otherwise.
func warn(pkg string) {
	banner := fmt.Sprintf(
		"\n!!! %s is set: database-backed tests in package %s did NOT run.\n"+
			"!!! Unset it and set %s to run them for real.\n\n",
		EnvOptOut, pkg, EnvDSN)
	if tty, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0); err == nil {
		fmt.Fprint(tty, banner)
		_ = tty.Close()
	}
	fmt.Fprint(os.Stderr, banner)
}

// callerPackage names the package under test, for the warning banner.
func callerPackage() string {
	if _, file, _, ok := runtime.Caller(2); ok {
		return filepath.Base(filepath.Dir(file))
	}
	return "unknown"
}
