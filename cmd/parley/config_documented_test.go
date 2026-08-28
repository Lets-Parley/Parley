package main

import (
	"bufio"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Configuration is environment variables only, and a variable nobody wrote
// down may as well not exist: the operator's two entry points are the
// configuration reference and the chart's values file. This test walks
// main.go's syntax tree, collects every environment key the process can read,
// and requires each one to appear in both.
//
// It resolves the callee rather than grepping for os.Getenv, because most of
// the configuration surface goes through the envOr helper — a literal-Getenv
// scan finds eight keys out of twenty-two and would report that as coverage.

// envReaders are the functions whose first argument names an environment
// variable. Add a third helper here rather than widening the pattern.
var envReaders = map[string]bool{"os.Getenv": true, "envOr": true}

// envKeyPattern is what an environment variable looks like. It gates the
// composite-literal sweep below, which is otherwise free to read any string.
var envKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$`)

const (
	configSource     = "main.go"
	allowListPath    = "env_keys_allowlist.txt"
	configReference  = "../../site/src/content/docs/reference/configuration.mdx"
	chartValuesFile  = "../../deploy/charts/parley/values.yaml"
	minimumCallReads = 10
)

// scanEnvKeys returns the keys main.go reads, and the set of reader functions
// it actually saw called.
func scanEnvKeys(t *testing.T) (map[string]bool, map[string]bool) {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, configSource, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}

	keys := map[string]bool{}
	readers := map[string]bool{}

	literal := func(e ast.Expr) (string, bool) {
		lit, ok := e.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return "", false
		}
		v, err := strconv.Unquote(lit.Value)
		if err != nil {
			return "", false
		}
		return v, true
	}

	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.CallExpr:
			var name string
			switch fun := node.Fun.(type) {
			case *ast.Ident:
				name = fun.Name
			case *ast.SelectorExpr:
				if pkg, ok := fun.X.(*ast.Ident); ok {
					name = pkg.Name + "." + fun.Sel.Name
				}
			}
			if !envReaders[name] || len(node.Args) == 0 {
				return true
			}
			readers[name] = true
			// A non-literal first argument is a dynamically-keyed read. The
			// key itself is still a string literal somewhere in the source —
			// the limits table below is one — so it is picked up by the
			// composite-literal sweep rather than hidden behind an entry in
			// the allow-list.
			if key, ok := literal(node.Args[0]); ok {
				keys[key] = true
			}
		case *ast.CompositeLit:
			// The limits table names its variables as struct-literal fields,
			// and the required-OIDC map as its own keys. Both are literals in
			// this file; walking them beats an allow-list, which rots.
			for _, elt := range node.Elts {
				switch e := elt.(type) {
				case *ast.KeyValueExpr:
					if key, ok := literal(e.Key); ok && envKeyPattern.MatchString(key) {
						keys[key] = true
					}
				default:
					if key, ok := literal(e); ok && envKeyPattern.MatchString(key) {
						keys[key] = true
					}
				}
			}
		}
		return true
	})
	return keys, readers
}

// readAllowList returns the keys listed in the checked-in allow-list, in file
// order. It holds keys no scan of main.go can find.
func readAllowList(t *testing.T) []string {
	t.Helper()
	f, err := os.Open(allowListPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var keys []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		keys = append(keys, line)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return keys
}

func TestEveryEnvironmentVariableIsDocumented(t *testing.T) {
	scanned, readers := scanEnvKeys(t)

	// The failure that makes this whole test worthless is finding nothing and
	// passing. A rename of the helper, a move of the config parser to another
	// file, a pattern that stops matching — each ends here rather than in a
	// green tick over an unread file.
	if len(scanned) == 0 {
		t.Fatalf("no environment keys found in %s — the scan is broken, not the configuration", configSource)
	}
	if len(scanned) < minimumCallReads {
		t.Fatalf("found only %d environment keys in %s (%v) — expected at least %d; the scan has stopped seeing most of the configuration surface",
			len(scanned), configSource, sortedKeys(scanned), minimumCallReads)
	}
	for name := range envReaders {
		if !readers[name] {
			t.Errorf("%s is listed as an environment reader but is never called in %s — if it was renamed, rename it here too, or this test quietly stops covering every key it used to read", name, configSource)
		}
	}

	for _, key := range readAllowList(t) {
		if scanned[key] {
			t.Errorf("%s is on the allow-list but the scan finds it in %s — drop the entry so the list cannot accumulate keys that stopped needing it", key, configSource)
		}
		scanned[key] = true
	}

	reference := mustRead(t, configReference)
	values := mustRead(t, chartValuesFile)
	for _, key := range sortedKeys(scanned) {
		if !strings.Contains(reference, key) {
			t.Errorf("%s is not named in the configuration reference (%s)", key, configReference)
		}
		if !strings.Contains(values, key) {
			t.Errorf("%s is not named in the chart's values file (%s)", key, chartValuesFile)
		}
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
