// Package dbtest resolves the database every database-backed test needs.
//
// A missing database is a failure, not a skip: `go test ./...` printing "ok"
// for a run where nothing touched Postgres is the worst outcome available.
// Local work that genuinely has no database can set PARLEY_SKIP_DB_TESTS, and
// pays for it with a warning naming every package it silenced.
package dbtest

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// EnvDSN is the connection string every database-backed test reads.
const EnvDSN = "TEST_DATABASE_URL"

// EnvOptOut, when set to anything non-empty, downgrades the missing-database
// failure to a loud skip. CI asserts it is unset.
const EnvOptOut = "PARLEY_SKIP_DB_TESTS"

type outcome int

const (
	useDSN outcome = iota
	skipNoisily
	failLoudly
)

func decide(dsn, optOut string) outcome {
	switch {
	case dsn != "":
		return useDSN
	case optOut != "":
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
	dsn := os.Getenv(EnvDSN)
	switch decide(dsn, os.Getenv(EnvOptOut)) {
	case useDSN:
		return dsn
	case skipNoisily:
		pkg := callerPackage()
		warnOnce.Do(func() {
			w := warnWriter()
			fmt.Fprintf(w,
				"\n!!! %s is set: database-backed tests in package %s did NOT run.\n"+
					"!!! Unset it and set %s to run them for real.\n\n",
				EnvOptOut, pkg, EnvDSN)
		})
		t.Skipf("%s set; skipping database-backed test", EnvOptOut)
	default:
		t.Fatalf("%s is not set: this test needs a database. Set %s=postgres://test:test@localhost:5432/test, "+
			"or set %s=1 to skip database-backed tests locally.", EnvDSN, EnvDSN, EnvOptOut)
	}
	return ""
}

// warnWriter picks somewhere the warning will actually be seen. `go test`
// swallows a passing package's stderr, so the banner goes to the terminal when
// there is one, and to stderr otherwise.
func warnWriter() io.Writer {
	tty, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0)
	if err != nil {
		return os.Stderr
	}
	return tty
}

// callerPackage names the package under test, for the warning banner.
func callerPackage() string {
	if _, file, _, ok := runtime.Caller(2); ok {
		return filepath.Base(filepath.Dir(file))
	}
	return "unknown"
}
