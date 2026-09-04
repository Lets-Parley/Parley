package db

import (
	"strings"
	"testing"
)

func TestTLSSettingsResolvesTheEffectiveMode(t *testing.T) {
	t.Setenv("PGSSLMODE", "")
	t.Setenv("PGSSLROOTCERT", "")

	for _, tc := range []struct {
		name     string
		url      string
		wantMode string
		wantRoot string
	}{
		// pgx defaults sslmode to "prefer", which silently falls back to
		// plaintext when the server offers no TLS. Silence must read as
		// "prefer", not as "unset".
		{"no parameter", "postgres://parley:secret@db:5432/parley", "prefer", ""},
		{"explicit disable", "postgres://db/parley?sslmode=disable", "disable", ""},
		{"verify-full with a root cert", "postgres://db/parley?sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem", "verify-full", "/etc/ssl/ca.pem"},
		{"mixed case", "postgres://db/parley?sslmode=Require", "require", ""},
		{"keyword value form", "host=db user=parley sslmode=verify-ca sslrootcert=/ca.pem", "verify-ca", "/ca.pem"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mode, root := TLSSettings(tc.url)
			if mode != tc.wantMode || root != tc.wantRoot {
				t.Fatalf("TLSSettings(%q) = %q, %q; want %q, %q", tc.url, mode, root, tc.wantMode, tc.wantRoot)
			}
		})
	}
}

// libpq's environment fallbacks are real: an operator who set PGSSLMODE has a
// TLS connection, and refusing it would be a false alarm.
func TestTLSSettingsHonoursThePGEnvironment(t *testing.T) {
	t.Setenv("PGSSLMODE", "verify-full")
	t.Setenv("PGSSLROOTCERT", "/etc/ssl/ca.pem")

	mode, root := TLSSettings("postgres://db/parley")
	if mode != "verify-full" || root != "/etc/ssl/ca.pem" {
		t.Fatalf("TLSSettings = %q, %q; want verify-full, /etc/ssl/ca.pem", mode, root)
	}

	// The connection string still wins over the environment, as libpq does it.
	if mode, _ := TLSSettings("postgres://db/parley?sslmode=disable"); mode != "disable" {
		t.Fatalf("sslmode in the URL = %q, want disable — the environment overrode the connection string", mode)
	}
}

func TestCheckTLSRefusesEveryPlaintextCapableMode(t *testing.T) {
	for _, mode := range []string{"disable", "allow", "prefer"} {
		err := CheckTLS(mode, false)
		if err == nil {
			t.Fatalf("sslmode=%s was accepted — every passcode would cross the network in the clear", mode)
		}
		if !strings.Contains(err.Error(), "DATABASE_ALLOW_PLAINTEXT") {
			t.Errorf("sslmode=%s error %q does not name the escape hatch", mode, err)
		}
		if err := CheckTLS(mode, true); err != nil {
			t.Errorf("sslmode=%s with the allow flag set: %v", mode, err)
		}
	}
}

func TestCheckTLSAcceptsTheEncryptedModes(t *testing.T) {
	for _, mode := range []string{"require", "verify-ca", "verify-full"} {
		if err := CheckTLS(mode, false); err != nil {
			t.Errorf("sslmode=%s was refused: %v", mode, err)
		}
	}
}

func TestCheckTLSRefusesAnUnknownMode(t *testing.T) {
	if err := CheckTLS("verify", false); err == nil {
		t.Fatal("sslmode=verify was accepted — a typo'd mode must not read as encrypted")
	}
}
