package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// TestMainStartsTheAuditPrune reads main.go: main must start
// auditPruner(...).RunAuditPrune in a go statement. Nothing else in the suite
// runs main, so without this a dropped line ships a prune that never runs.
func TestMainStartsTheAuditPrune(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "main" {
			continue
		}
		ast.Inspect(fn, func(n ast.Node) bool {
			g, ok := n.(*ast.GoStmt)
			if !ok {
				return true
			}
			sel, ok := g.Call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "RunAuditPrune" {
				return true
			}
			if inner, ok := sel.X.(*ast.CallExpr); ok {
				if id, ok := inner.Fun.(*ast.Ident); ok && id.Name == "auditPruner" {
					found = true
				}
			}
			return true
		})
	}
	if !found {
		t.Fatal("main does not start `go auditPruner(pool).RunAuditPrune(...)`: the audit prune would never run")
	}
}
