package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// applyConfigFile merges an optional file of KEY=value lines *under* the
// environment: a variable already set in the environment keeps its value, and
// the file only fills the gaps. That ordering is the point — a container's
// environment must always be able to override a file baked into an image.
//
// The file is named by PARLEY_CONFIG_FILE. It is optional, but once named it
// must exist and parse: a typo'd path that silently ran on defaults is exactly
// the failure a fail-fast process exists to prevent.
//
// Syntax is deliberately tiny: blank lines, `#` comments, and KEY=value with
// optional surrounding whitespace and optional quotes around the value. There
// is no interpolation, no export, no multi-line value.
func applyConfigFile() error {
	path := strings.TrimSpace(os.Getenv("PARLEY_CONFIG_FILE"))
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("PARLEY_CONFIG_FILE: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		key, value, ok := strings.Cut(text, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return fmt.Errorf("%s line %d: %q is not KEY=value", path, line, text)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if os.Getenv(key) != "" {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("%s line %d: setting %s: %w", path, line, key, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("reading %s: %w", path, err)
	}
	return nil
}
