package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "parley.conf")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfigFileFillsGapsAndTheEnvironmentStillWins(t *testing.T) {
	path := writeConfig(t, strings.Join([]string{
		"# a comment",
		"",
		"LOG_LEVEL=debug",
		"  PORT = 9999  ",
		`BASE_URL="http://example.test"`,
		"DATABASE_URL=postgres://from-the-file/parley",
	}, "\n"))

	t.Setenv("PARLEY_CONFIG_FILE", path)
	t.Setenv("DATABASE_URL", "postgres://from-the-environment/parley")
	t.Setenv("LOG_LEVEL", "")

	if err := applyConfigFile(); err != nil {
		t.Fatal(err)
	}

	if got := os.Getenv("DATABASE_URL"); got != "postgres://from-the-environment/parley" {
		t.Fatalf("DATABASE_URL is %q — the config file overwrote the environment", got)
	}
	for key, want := range map[string]string{
		"LOG_LEVEL": "debug",
		"PORT":      "9999",
		"BASE_URL":  "http://example.test",
	} {
		if got := os.Getenv(key); got != want {
			t.Errorf("%s is %q, want %q from the config file", key, got, want)
		}
	}
}

func TestAMissingOrMalformedConfigFileStopsTheProcess(t *testing.T) {
	t.Setenv("PARLEY_CONFIG_FILE", filepath.Join(t.TempDir(), "absent.conf"))
	if err := applyConfigFile(); err == nil {
		t.Fatal("a config file that does not exist was accepted — a typo'd path would silently run on defaults")
	}

	t.Setenv("PARLEY_CONFIG_FILE", writeConfig(t, "LOG_LEVEL debug\n"))
	if err := applyConfigFile(); err == nil {
		t.Fatal("a line with no = was accepted")
	}
}

func TestNoConfigFileIsNotAnError(t *testing.T) {
	t.Setenv("PARLEY_CONFIG_FILE", "")
	if err := applyConfigFile(); err != nil {
		t.Fatalf("applyConfigFile with no file configured returned %v", err)
	}
}
