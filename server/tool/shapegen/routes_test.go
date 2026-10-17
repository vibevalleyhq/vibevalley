package main

import (
	"go/ast"
	"testing"
)

func TestRouteOwnsParameterBindings(t *testing.T) {
	r := route{goName: "Example", path: "/items/{id}", params: []param{
		{name: "pID", typ: ast.NewIdent("string")},
		{name: "pLimit", typ: &ast.StarExpr{X: ast.NewIdent("int64")}},
		{name: "body", typ: ast.NewIdent("Request")},
	}}
	if err := r.bind(); err != nil {
		t.Fatal(err)
	}
	for i, want := range []struct {
		source paramSource
		wire   string
	}{{paramPath, "id"}, {paramQuery, "limit"}, {paramBody, "body"}} {
		if r.params[i].source != want.source || r.params[i].wire != want.wire {
			t.Fatalf("parameter %d: %+v", i, r.params[i])
		}
	}
	r.path = "/items/{id}/{other}"
	if err := r.bind(); err == nil {
		t.Fatal("accepted unbound path")
	}
	r.path = "/items"
	if err := r.bind(); err == nil {
		t.Fatal("accepted extra path argument")
	}
}
