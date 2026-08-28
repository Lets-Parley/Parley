package main

import (
	"bufio"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
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
// configuration reference and the chart's values file. This test walks the
// syntax tree of every non-test file under cmd/ and internal/, collects every
// environment key the process can read, and requires each one to appear in
// both.
//
// It resolves the callee rather than grepping for os.Getenv, because most of
// the configuration surface goes through the envOr helper — a literal-Getenv
// scan finds eight keys out of twenty-two and would report that as coverage.
//
// Three failures are what keep the check from going quietly blind:
//
//   - a registered reader that is never called anywhere (renamed, and the scan
//     silently stopped covering the keys it used to read);
//   - a call somewhere in the tree whose first argument is a literal shaped
//     like an environment key but whose callee is not a registered reader —
//     that is a new helper nobody registered, which would otherwise read
//     configuration this test never sees;
//   - finding implausibly few keys at all.
//
// The unregistered-callee rule is gated on envKeyPattern, so a new helper
// reading a single-word key (PORT) would still slip past it. That is the
// residual gap; the reader liveness rule and the minimum below cover the rest.

// envReaders are the functions whose first argument names an environment
// variable. Add a third helper here rather than widening the pattern — the
// unregistered-callee rule below exists to make forgetting loud.
var envReaders = map[string]bool{"os.Getenv": true, "envOr": true}

// envKeyPattern is what an environment variable looks like. It gates the
// composite-literal sweep below, which is otherwise free to read any string,
// and the unregistered-callee rule, which is otherwise free to flag any call.
var envKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$`)

const (
	allowListPath    = "env_keys_allowlist.txt"
	configReference  = "../../site/src/content/docs/reference/configuration.mdx"
	chartValuesFile  = "../../deploy/charts/parley/values.yaml"
	minimumCallReads = 10
)

// scanRoots are the trees walked for environment reads. Everything the binary
// links is under one of these, so a read that moves out of main.go stays
// covered rather than needing an allow-list entry.
var scanRoots = []string{"../../cmd", "../../internal"}

// compositeSweepFile is the one file whose composite literals are also read.
// main.go builds its rate-limit table out of struct literals naming the keys,
// which no callee resolution can see. Sweeping every literal in every package
// would collect any shouty constant in the tree, so this stays scoped.
var compositeSweepFile = filepath.Clean("../../cmd/parley/main.go")

// envScan is what one walk of the trees found.
type envScan struct {
	keys         map[string]bool
	readers      map[string]bool
	unregistered []string
}

func literalString(e ast.Expr) (string, bool) {
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

// callName renders a call's callee as "pkg.Func" or "Func", or "" if it is
// neither a plain identifier nor a package selector.
func callName(node *ast.CallExpr) string {
	switch fun := node.Fun.(type) {
	case *ast.Ident:
		return fun.Name
	case *ast.SelectorExpr:
		if pkg, ok := fun.X.(*ast.Ident); ok {
			return pkg.Name + "." + fun.Sel.Name
		}
	}
	return ""
}

// scanEnvKeys walks scanRoots and returns the keys read, the reader functions
// actually seen called, and every call that looks like an unregistered reader.
func scanEnvKeys(t *testing.T) envScan {
	t.Helper()
	scan := envScan{keys: map[string]bool{}, readers: map[string]bool{}}
	fset := token.NewFileSet()

	for _, root := range scanRoots {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if d.Name() == "testdata" || d.Name() == "vendor" {
					return fs.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
			if err != nil {
				return err
			}
			sweepComposites := filepath.Clean(path) == compositeSweepFile

			ast.Inspect(file, func(n ast.Node) bool {
				switch node := n.(type) {
				case *ast.CallExpr:
					if len(node.Args) == 0 {
						return true
					}
					name := callName(node)
					key, isLiteral := literalString(node.Args[0])
					if !envReaders[name] {
						// A call nobody registered, handed a string shaped like
						// an environment key. That is how a new helper reads
						// configuration this scan would never see.
						if isLiteral && envKeyPattern.MatchString(key) && name != "" {
							scan.unregistered = append(scan.unregistered, fmt.Sprintf(
								"%s(%q) at %s", name, key, fset.Position(node.Pos())))
						}
						return true
					}
					scan.readers[name] = true
					// A non-literal first argument is a dynamically-keyed read.
					// The key itself is still a string literal somewhere in the
					// source — the limits table is one — so it is picked up by
					// the composite-literal sweep rather than hidden behind an
					// entry in the allow-list.
					if isLiteral {
						scan.keys[key] = true
					}
				case *ast.CompositeLit:
					// The limits table names its variables as struct-literal
					// fields, and the required-OIDC map as its own keys. Both
					// are literals in main.go; walking them beats an allow-list,
					// which rots.
					if !sweepComposites {
						return true
					}
					for _, elt := range node.Elts {
						switch e := elt.(type) {
						case *ast.KeyValueExpr:
							if key, ok := literalString(e.Key); ok && envKeyPattern.MatchString(key) {
								scan.keys[key] = true
							}
						default:
							if key, ok := literalString(e); ok && envKeyPattern.MatchString(key) {
								scan.keys[key] = true
							}
						}
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return scan
}

// readAllowList returns the keys listed in the checked-in allow-list, in file
// order. It holds keys no scan of the source can find.
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

// namesKey reports whether doc mentions key as a whole word. A substring match
// would let "PARLEY_FOO_LEGACY is not a real variable" satisfy PARLEY_FOO, and
// any prose containing SUPPORT satisfy PORT.
func namesKey(doc, key string) bool {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(key) + `\b`).MatchString(doc)
}

func TestEveryEnvironmentVariableIsDocumented(t *testing.T) {
	scan := scanEnvKeys(t)
	scanned := scan.keys

	// The failure that makes this whole test worthless is finding nothing and
	// passing. A rename of the helper, a move of the config parser to another
	// file, a pattern that stops matching — each ends here rather than in a
	// green tick over an unread file.
	if len(scanned) == 0 {
		t.Fatalf("no environment keys found under %v — the scan is broken, not the configuration", scanRoots)
	}
	if len(scanned) < minimumCallReads {
		t.Fatalf("found only %d environment keys under %v (%v) — expected at least %d; the scan has stopped seeing most of the configuration surface",
			len(scanned), scanRoots, sortedKeys(scanned), minimumCallReads)
	}
	for name := range envReaders {
		if !scan.readers[name] {
			t.Errorf("%s is listed as an environment reader but is never called under %v — if it was renamed, rename it here too, or this test quietly stops covering every key it used to read", name, scanRoots)
		}
	}
	for _, call := range scan.unregistered {
		t.Errorf("%s reads what looks like an environment variable, but its callee is not in envReaders — register the helper there so its keys are covered, or this test quietly stops seeing that configuration", call)
	}

	for _, key := range readAllowList(t) {
		if scanned[key] {
			t.Errorf("%s is on the allow-list but the scan finds it in the source — drop the entry so the list cannot accumulate keys that stopped needing it", key)
		}
		scanned[key] = true
	}

	reference := mustRead(t, configReference)
	values := mustRead(t, chartValuesFile)
	for _, key := range sortedKeys(scanned) {
		if !namesKey(reference, key) {
			t.Errorf("%s is not named in the configuration reference (%s)", key, configReference)
		}
		if !namesKey(values, key) {
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
