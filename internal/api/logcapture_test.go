package api

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
)

// logCapture is the slog sink tests install via slog.SetDefault. A bare
// bytes.Buffer is not safe for concurrent use: background goroutines from
// other tests' Router() calls (the presence sweeper, the notification
// listener) keep logging through the process-global default and race with
// the owning test's String().
type logCapture struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func newLogCapture() *logCapture {
	return &logCapture{}
}

func (c *logCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Write(p)
}

func (c *logCapture) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

func captureDefaultJSON(t *testing.T) *logCapture {
	t.Helper()
	buf := newLogCapture()
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

var _ io.Writer = (*logCapture)(nil)

// TestLogCaptureIsSafeForConcurrentWriteAndString is the race CI saw between
// TestSignOutEmitsASecurityEventOnlyWhenASessionIsDeleted reading the capture
// buffer and a presence sweeper from another test writing into it.
func TestLogCaptureIsSafeForConcurrentWriteAndString(t *testing.T) {
	buf := newLogCapture()
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 1000 {
				_, _ = buf.Write([]byte(`{"msg":"could not sweep stale presence rows"}` + "\n"))
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for range 1000 {
			_ = buf.String()
		}
	}()
	wg.Wait()
}

// TestSlogSinksAreNotABareBytesBuffer holds the other half of the race fix:
// every slog handler in this package's tests must write to logCapture, not
// a bytes.Buffer. slog.SetDefault is process-global, so a new site that
// reconstructs the old pattern reintroduces the flake.
func TestSlogSinksAreNotABareBytesBuffer(t *testing.T) {
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		bufferIdents := map[string]token.Pos{}
		ast.Inspect(f, func(n ast.Node) bool {
			decl, ok := n.(*ast.GenDecl)
			if !ok || decl.Tok != token.VAR {
				return true
			}
			for _, spec := range decl.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok || !isBytesBufferType(vs.Type) {
					continue
				}
				for _, ident := range vs.Names {
					bufferIdents[ident.Name] = ident.Pos()
				}
			}
			return true
		})
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (sel.Sel.Name != "NewJSONHandler" && sel.Sel.Name != "NewTextHandler") {
				return true
			}
			if len(call.Args) < 1 {
				return true
			}
			unary, ok := call.Args[0].(*ast.UnaryExpr)
			if !ok || unary.Op != token.AND {
				return true
			}
			ident, ok := unary.X.(*ast.Ident)
			if !ok {
				return true
			}
			if _, isBuf := bufferIdents[ident.Name]; isBuf {
				t.Errorf("%s: slog handler writes to a bare bytes.Buffer (%s); use newLogCapture()", fset.Position(call.Pos()), ident.Name)
			}
			return true
		})
	}
}

func isBytesBufferType(expr ast.Expr) bool {
	sel, ok := expr.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Buffer" {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "bytes"
}
