package main

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// The whole point of the control: an operator who never thought about TLS gets
// a refusal at boot, not a silent plaintext session carrying passcodes.
func TestLoadConfigRefusesAPlaintextDatabaseURL(t *testing.T) {
	for _, url := range []string{
		"postgres://parley:secret@db:5432/parley",
		"postgres://parley:secret@db:5432/parley?sslmode=disable",
		"postgres://parley:secret@db:5432/parley?sslmode=allow",
		"postgres://parley:secret@db:5432/parley?sslmode=prefer",
	} {
		t.Run(url, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv("DATABASE_URL", url)

			_, err := loadConfig()
			if err == nil {
				t.Fatal("boot accepted a plaintext-capable DATABASE_URL")
			}
			if !strings.Contains(err.Error(), "DATABASE_ALLOW_PLAINTEXT") {
				t.Fatalf("error %q does not name DATABASE_ALLOW_PLAINTEXT", err)
			}
		})
	}
}

func TestLoadConfigAllowsPlaintextWhenTheFlagIsSet(t *testing.T) {
	baseConfigEnv(t)
	t.Setenv("DATABASE_URL", "postgres://parley:secret@db:5432/parley")
	t.Setenv("DATABASE_ALLOW_PLAINTEXT", "true")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DBSSLMode != "prefer" {
		t.Fatalf("db_sslmode = %q, want prefer", cfg.DBSSLMode)
	}
}

func TestLoadConfigRejectsANonBooleanAllowFlag(t *testing.T) {
	baseConfigEnv(t)
	t.Setenv("DATABASE_ALLOW_PLAINTEXT", "yes-please")
	if _, err := loadConfig(); err == nil {
		t.Fatal("a non-boolean DATABASE_ALLOW_PLAINTEXT was accepted")
	}
}

func TestLoadConfigAcceptsEveryEncryptedMode(t *testing.T) {
	for _, mode := range []string{"require", "verify-ca", "verify-full"} {
		t.Run(mode, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv("DATABASE_URL", "postgres://parley:secret@db:5432/parley?sslmode="+mode)

			cfg, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.DBSSLMode != mode {
				t.Fatalf("db_sslmode = %q, want %q", cfg.DBSSLMode, mode)
			}
		})
	}
}

// An operator cannot confirm the connection is encrypted without being told
// which mode was resolved — "prefer" and "verify-full" look identical from a
// running pod otherwise.
func TestBootFieldsCarryTheEffectiveSSLMode(t *testing.T) {
	cfg := bootConfig(t)
	cfg.DBSSLMode = "verify-full"

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("boot settings", bootFields(cfg, true)...)

	if !strings.Contains(buf.String(), `"db_sslmode":"verify-full"`) {
		t.Fatalf("boot line %s does not carry db_sslmode", buf.String())
	}
}

// sslmode=require is the mode that reads as "done" and is not: it encrypts and
// then trusts any certificate offered.
func TestRequireWithoutARootCertIsWarnedAbout(t *testing.T) {
	for _, tc := range []struct {
		mode, rootCert string
		wantWarning    bool
	}{
		{"require", "", true},
		{"require", "/etc/ssl/ca.pem", false},
		{"verify-full", "", false},
	} {
		cfg := bootConfig(t)
		cfg.DBSSLMode, cfg.DBRootCert = tc.mode, tc.rootCert

		var buf bytes.Buffer
		warnAboutDatabaseTLS(cfg, slog.New(slog.NewJSONHandler(&buf, nil)))

		warned := strings.Contains(buf.String(), "verify-full")
		if warned != tc.wantWarning {
			t.Errorf("sslmode=%s sslrootcert=%q warned=%v, want %v (%s)", tc.mode, tc.rootCert, warned, tc.wantWarning, buf.String())
		}
	}
}
