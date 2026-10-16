// Command shapegen writes what follows from the protocol's shapes (internal/protocol/shapes.go) and endpoints
// (internal/protocol/api.go): the Go glue in internal/protocol/gen.go (tagged unions' codecs, empty slices and maps
// written as [] and {}, enum value lists, union member lists, the API's error types, Mount) and the Flutter client's
// types and API client in app/lib/gen/vibevalley.dart. The shapes are Go, the one source; nothing here is written by
// hand twice.
//
//	go run ./tool/shapegen          # from server/: write both
//	go run ./tool/shapegen -check   # fail when either is stale
//
// The directives in shapes.go and api.go:
//
//	//vibevalley:union <field>           on `type X struct{ Value XValue }`: X is a tagged union told apart by <field>
//	//vibevalley:member <Union> <v>...   on a struct: a member of Union for tag value(s) v (one value: the tag is not a field)
//	//vibevalley:error <status>          on a struct: an API error, answered with that status and tagged with its name
//	//vibevalley:dart <Name>             the Dart name, when the Go one would clash with Flutter's (Badge)
//	//vibevalley:route <group.op> <METHOD> <path>   on a Handlers method: its operation, method and path
//
// A field is optional with `json:",omitzero"`, and may be null as a pointer, or with `vibevalley:"null"` where it cannot be
// one (a slice, a map, a union): neither is written as [] or {} when nil.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
)

func main() {
	check := flag.Bool("check", false, "fail when a written file is stale")
	flag.Parse()
	s := load("internal/protocol/shapes.go", "internal/protocol/api.go")
	goOut := s.goFile()
	dartOut := formatDart(s.dartFile())
	outputs := []struct{ path, body string }{{"internal/protocol/gen.go", goOut}, {"../app/lib/gen/vibevalley.dart", dartOut}}
	stale := false
	for _, o := range outputs {
		if *check {
			old, _ := os.ReadFile(o.path)
			if string(old) != o.body {
				fmt.Fprintf(os.Stderr, "stale: %s (go run ./tool/shapegen)\n", o.path)
				stale = true
			}
			continue
		}
		if err := os.WriteFile(o.path, []byte(o.body), 0o644); err != nil {
			fail(err)
		}
	}
	if stale {
		os.Exit(1)
	}
}

// formatDart is body as dart format writes it (as the Flutter tree keeps every file).
func formatDart(body string) string {
	dir, err := os.MkdirTemp("", "shapegen")
	if err != nil {
		fail(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "vibevalley.dart")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		fail(err)
	}
	if out, err := exec.Command("dart", "format", "--line-length", "160", path).CombinedOutput(); err != nil {
		fail(fmt.Errorf("dart format: %v\n%s", err, out))
	}
	formatted, err := os.ReadFile(path)
	if err != nil {
		fail(err)
	}
	return string(formatted)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "shapegen:", err)
	os.Exit(1)
}

// ── The shapes, read ─────────────────────────────────────────────────────────

type membership struct {
	union  string
	values []string
}

type field struct {
	goName, json string
	typ          ast.Expr
	omit         bool // omitzero: optional
	null         bool // vibevalley:"null": may be null though it is no pointer (a slice, a map, a union)
}

type decl struct {
	name    string
	kind    string // struct, enum, union, other
	fields  []field
	values  []string // an enum's, in order
	consts  []string // an enum's constant names, in order
	tag     string   // a union's tag field
	members []membership
	status  string // an API error's status
	dart    string // a Dart name given by hand
}

type route struct {
	group, op, method, path, goName string
	params                          []param
	result                          ast.Expr // nil: no answer
	doc                             []string
}

type param struct {
	name string
	typ  ast.Expr
}

type shapes struct {
	decls  []*decl
	byName map[string]*decl
	routes []route
	src    map[string][]byte
	fset   *token.FileSet
}

func load(files ...string) *shapes {
	s := &shapes{byName: map[string]*decl{}, src: map[string][]byte{}, fset: token.NewFileSet()}
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			fail(err)
		}
		s.src[file] = body
		f, err := parser.ParseFile(s.fset, file, body, parser.ParseComments)
		if err != nil {
			fail(err)
		}
		for _, d := range f.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok {
				continue
			}
			switch gd.Tok {
			case token.TYPE:
				for _, spec := range gd.Specs {
					s.typeSpec(gd, spec.(*ast.TypeSpec))
				}
			case token.CONST:
				for _, spec := range gd.Specs {
					vs := spec.(*ast.ValueSpec)
					id, ok := vs.Type.(*ast.Ident)
					if !ok || len(vs.Values) != 1 {
						continue
					}
					d := s.byName[id.Name]
					if d == nil {
						fail(fmt.Errorf("constant %s of unknown type %s", vs.Names[0].Name, id.Name))
					}
					v, err := strconv.Unquote(vs.Values[0].(*ast.BasicLit).Value)
					if err != nil {
						fail(err)
					}
					d.kind = "enum"
					d.values = append(d.values, v)
					d.consts = append(d.consts, vs.Names[0].Name)
				}
			}
		}
	}
	return s
}

var directive = regexp.MustCompile(`^//vibevalley:(\w+) (.+)$`)

func directives(groups ...*ast.CommentGroup) (out [][2]string, doc []string) {
	for _, g := range groups {
		if g == nil {
			continue
		}
		for _, c := range g.List {
			if m := directive.FindStringSubmatch(c.Text); m != nil {
				out = append(out, [2]string{m[1], m[2]})
			} else if strings.HasPrefix(c.Text, "//") {
				doc = append(doc, strings.TrimPrefix(strings.TrimPrefix(c.Text, "//"), " "))
			}
		}
	}
	return out, doc
}

func (s *shapes) typeSpec(gd *ast.GenDecl, ts *ast.TypeSpec) {
	name := ts.Name.Name
	if name == "Handlers" {
		s.handlers(ts.Type.(*ast.InterfaceType))
		return
	}
	d := &decl{name: name, kind: "other"}
	dirs, _ := directives(gd.Doc, ts.Doc)
	for _, dir := range dirs {
		args := strings.Fields(dir[1])
		switch dir[0] {
		case "union":
			d.tag = args[0]
		case "member":
			d.members = append(d.members, membership{args[0], args[1:]})
		case "error":
			d.status = args[0]
		case "dart":
			d.dart = args[0]
		default:
			fail(fmt.Errorf("%s: unknown directive vibevalley:%s", name, dir[0]))
		}
	}
	switch t := ts.Type.(type) {
	case *ast.StructType:
		d.kind = "struct"
		if d.tag != "" {
			d.kind = "union"
		}
		for _, f := range t.Fields.List {
			var tags reflect.StructTag
			if f.Tag != nil {
				tags = reflect.StructTag(mustUnquote(f.Tag.Value))
			}
			parts := strings.Split(tags.Get("json"), ",")
			for _, n := range f.Names {
				d.fields = append(d.fields, field{goName: n.Name, json: parts[0], typ: f.Type, omit: slicesContain(parts[1:], "omitzero"), null: tags.Get("vibevalley") == "null"})
			}
		}
	case *ast.Ident:
		if t.Name != "string" {
			fail(fmt.Errorf("%s: only string-based named types are shapes", name))
		}
		d.kind = "enum"
	default:
		fail(fmt.Errorf("%s: not a struct or an enum", name))
	}
	s.decls = append(s.decls, d)
	s.byName[name] = d
}

func (s *shapes) handlers(it *ast.InterfaceType) {
	for _, m := range it.Methods.List {
		dirs, doc := directives(m.Doc)
		r := route{goName: m.Names[0].Name, doc: doc}
		for _, dir := range dirs {
			if dir[0] != "route" {
				fail(fmt.Errorf("%s: unknown directive vibevalley:%s", r.goName, dir[0]))
			}
			args := strings.Fields(dir[1])
			group, op, _ := strings.Cut(args[0], ".")
			r.group, r.op, r.method, r.path = group, op, args[1], args[2]
		}
		if r.path == "" {
			fail(fmt.Errorf("%s has no vibevalley:route", r.goName))
		}
		ft := m.Type.(*ast.FuncType)
		for i, p := range ft.Params.List {
			if i == 0 {
				continue // ctx
			}
			for _, n := range p.Names {
				r.params = append(r.params, param{n.Name, p.Type})
			}
		}
		if ft.Results != nil && len(ft.Results.List) == 2 {
			r.result = ft.Results.List[0].Type
		}
		s.routes = append(s.routes, r)
	}
}

func mustUnquote(s string) string {
	u, err := strconv.Unquote(s)
	if err != nil {
		fail(err)
	}
	return u
}

func slicesContain(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func (s *shapes) text(e ast.Expr) string {
	var b bytes.Buffer
	if err := format.Node(&b, s.fset, e); err != nil {
		fail(err)
	}
	return b.String()
}

// ── Go ───────────────────────────────────────────────────────────────────────

// fills are a struct's fields written as [] or {} when nil: required slices and maps (the decoders refuse null).
func (s *shapes) fills(d *decl, skip string) []string {
	var out []string
	for _, f := range d.fields {
		if f.omit || f.null || f.json == skip {
			continue
		}
		switch t := f.typ.(type) {
		case *ast.ArrayType:
			out = append(out, fmt.Sprintf("\tif p.%s == nil {\n\t\tp.%s = %s{}\n\t}", f.goName, f.goName, s.text(t)))
		case *ast.MapType:
			out = append(out, fmt.Sprintf("\tif p.%s == nil {\n\t\tp.%s = %s{}\n\t}", f.goName, f.goName, s.text(t)))
		}
	}
	return out
}

func (s *shapes) goFile() string {
	var b strings.Builder
	b.WriteString(`// Code generated by tool/shapegen from internal/protocol/shapes.go and api.go. DO NOT EDIT: change those and run
// go run ./tool/shapegen.

package protocol

import (
	"encoding/json"
	"fmt"
	"net/http"
)
`)
	marshal := func(name string, fills []string, last string) {
		if len(fills) == 0 && last == "" {
			return
		}
		if last == "" {
			last = "\treturn json.Marshal(p)"
		}
		fmt.Fprintf(&b, "\nfunc (v %s) MarshalJSON() ([]byte, error) {\n\ttype plain %s\n\tp := plain(v)\n%s\n%s\n}\n", name, name, strings.Join(fills, "\n"), last)
	}
	for _, d := range s.decls {
		switch {
		case d.status != "":
			continue
		case d.kind == "enum":
			fmt.Fprintf(&b, "\n// %sValues are every %s, in the protocol's order.\nvar %sValues = []%s{%s}\n", d.name, d.name, d.name, d.name, strings.Join(d.consts, ", "))
		case d.kind == "union":
			var subs, cases, zeros []string
			for _, m := range s.membersOf(d.name) {
				subs = append(subs, m.decl.name)
				zeros = append(zeros, m.decl.name+"{}")
				for _, v := range m.values {
					cases = append(cases, fmt.Sprintf("\tcase %q:\n\t\tvar v %s\n\t\terr = json.Unmarshal(data, &v)\n\t\tu.Value = v", v, m.decl.name))
				}
			}
			n := d.name
			fmt.Fprintf(&b, `
// %[1]sValue is a member of %[1]s: %[2]s, told apart by %[3]q.
type %[1]sValue interface{ is%[1]s() }

func (u %[1]s) IsZero() bool { return u.Value == nil }

func (u %[1]s) MarshalJSON() ([]byte, error) {
	if u.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(u.Value)
}

func (u *%[1]s) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		u.Value = nil
		return nil
	}
	var head struct {
		Tag string `+"`json:%[3]q`"+`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return err
	}
	var err error
	switch head.Tag {
%[4]s
	default:
		return fmt.Errorf("%[1]s: unknown %[5]s %%q", head.Tag)
	}
	return err
}

// %[1]sMembers are every member of %[1]s, each zero, in the protocol's order: a test can see that a switch meant to
// handle every one of them does.
var %[1]sMembers = []%[1]sValue{%[6]s}
`, n, strings.Join(subs, ", "), d.tag, strings.Join(cases, "\n"), d.tag, strings.Join(zeros, ", "))
		case d.kind == "struct":
			for _, m := range d.members {
				fmt.Fprintf(&b, "\nfunc (%s) is%s() {}\n", d.name, m.union)
			}
			if len(d.members) > 0 && len(d.members[0].values) == 1 {
				tag := s.byName[d.members[0].union].tag
				marshal(d.name, s.fills(d, tag), fmt.Sprintf("\treturn withTag(p, %q, %q)", tag, d.members[0].values[0]))
			} else {
				marshal(d.name, s.fills(d, ""), "")
			}
		}
	}
	for _, d := range s.decls {
		if d.status == "" {
			continue
		}
		message := strconv.Quote(d.name)
		if len(d.fields) > 0 {
			message = "e." + d.fields[0].goName
		}
		fmt.Fprintf(&b, `
func (e %[1]s) Error() string { return %[2]s }

func (%[1]s) HTTPStatus() int { return %[3]s }

func (e %[1]s) MarshalJSON() ([]byte, error) {
	type plain %[1]s
	return withTag(plain(e), "_tag", %[1]q)
}
`, d.name, message, d.status)
	}
	b.WriteString("\n// Mount routes every VibeValleyApi endpoint on mux to h: requests decoded, answers and tagged errors encoded (200 with\n// JSON, 204 when there is nothing to say, the error's own status).\nfunc Mount(mux *http.ServeMux, h Handlers) {\n")
	for _, r := range s.routes {
		var reads, args []string
		args = append(args, "r.Context()")
		path := pathParams(r.path)
		i := 0
		for _, p := range r.params {
			switch {
			case p.name == "body":
				reads = append(reads, fmt.Sprintf("\t\tvar body %s\n\t\tif !decode(w, r, &body) {\n\t\t\treturn\n\t\t}", s.text(p.typ)))
			case isPointer(p.typ):
				reads = append(reads, fmt.Sprintf("\t\t%s := query(r, %q)", p.name, queryName(p.name)))
			default:
				if i >= len(path) {
					fail(fmt.Errorf("%s: more path parameters than %s has", r.goName, r.path))
				}
				read := fmt.Sprintf("r.PathValue(%q)", path[i])
				if t := s.text(p.typ); t != "string" {
					read = fmt.Sprintf("%s(%s)", t, read)
				}
				reads = append(reads, fmt.Sprintf("\t\t%s := %s", p.name, read))
				i++
			}
			args = append(args, p.name)
		}
		call := fmt.Sprintf("h.%s(%s)", r.goName, strings.Join(args, ", "))
		fmt.Fprintf(&b, "\tmux.HandleFunc(%q, func(w http.ResponseWriter, r *http.Request) {\n", r.method+" "+r.path)
		for _, rd := range reads {
			b.WriteString(rd + "\n")
		}
		if r.result != nil {
			fmt.Fprintf(&b, "\t\tout, err := %s\n\t\tanswer(w, out, err)\n", call)
		} else {
			fmt.Fprintf(&b, "\t\tanswer(w, nil, %s)\n", call)
		}
		b.WriteString("\t})\n")
	}
	b.WriteString("}\n")
	out, err := format.Source([]byte(b.String()))
	if err != nil {
		os.WriteFile(filepath.Join(os.TempDir(), "shapegen-gen.go"), []byte(b.String()), 0o644)
		fail(fmt.Errorf("gen.go: %w", err))
	}
	return string(out)
}

type member struct {
	decl   *decl
	values []string
}

func (s *shapes) membersOf(union string) []member {
	var out []member
	for _, d := range s.decls {
		for _, m := range d.members {
			if m.union == union {
				out = append(out, member{d, m.values})
			}
		}
	}
	return out
}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

func pathParams(path string) []string {
	var out []string
	for _, m := range placeholder.FindAllStringSubmatch(path, -1) {
		out = append(out, m[1])
	}
	return out
}

func isPointer(e ast.Expr) bool { _, ok := e.(*ast.StarExpr); return ok }

// queryName is a Go parameter's query name: pBefore → before, pID → id.
func queryName(goName string) string {
	n := strings.TrimPrefix(goName, "p")
	if strings.ToUpper(n) == n {
		return strings.ToLower(n)
	}
	return strings.ToLower(n[:1]) + n[1:]
}

// ── Dart ─────────────────────────────────────────────────────────────────────

var initialisms = map[string]bool{"id": true, "url": true, "mcp": true, "api": true, "cny": true, "json": true, "http": true, "uid": true, "asr": true, "llm": true, "tts": true, "tz": true}

// dartName is a Go name with its initialisms written as Dart writes words (MCPServerHTTP → McpServerHttp).
func dartName(goName string) string {
	var b strings.Builder
	rest := goName
	for rest != "" {
		matched := false
		for n := 4; n >= 2; n-- {
			if len(rest) >= n && strings.ToUpper(rest[:n]) == rest[:n] && initialisms[strings.ToLower(rest[:n])] {
				next := rest[n:]
				if next == "" || !(next[0] >= 'a' && next[0] <= 'z') {
					b.WriteString(rest[:1] + strings.ToLower(rest[1:n]))
					rest = next
					matched = true
					break
				}
			}
		}
		if !matched {
			b.WriteByte(rest[0])
			rest = rest[1:]
		}
	}
	return b.String()
}

func (s *shapes) dartNameOf(d *decl) string {
	if d.dart != "" {
		return d.dart
	}
	return dartName(d.name)
}

var (
	words   = regexp.MustCompile(`[^A-Za-z0-9]+`)
	leading = regexp.MustCompile(`^_+`)
)

// pascal and camel name Dart fields and enum cases: words split at every capital and at anything not a letter or digit.
func pascal(s string) string {
	s = leading.ReplaceAllString(s, "")
	var b strings.Builder
	for _, part := range words.Split(s, -1) {
		start := 0
		for i := 1; i <= len(part); i++ {
			if i == len(part) || (part[i] >= 'A' && part[i] <= 'Z') {
				w := part[start:i]
				if w != "" {
					b.WriteString(strings.ToUpper(w[:1]) + w[1:])
				}
				start = i
			}
		}
	}
	return b.String()
}

func camel(s string) string {
	p := pascal(s)
	if p == "" {
		return ""
	}
	if p[0] >= '0' && p[0] <= '9' {
		return "v" + p
	}
	return strings.ToLower(p[:1]) + p[1:]
}

var dartReserved = map[string]bool{"final": true, "default": true, "class": true, "enum": true, "in": true, "is": true, "new": true, "null": true, "switch": true, "case": true, "var": true, "const": true, "this": true, "with": true, "get": true, "set": true}

func dartField(name string) string {
	if dartReserved[camel(name)] {
		return camel(name) + "_"
	}
	return camel(name)
}

func dartStr(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `'`, `\'`, `$`, `\$`)
	return "'" + r.Replace(s) + "'"
}

type dartType struct {
	typ         string
	read, write func(string) string
}

func plainDart(t string, read func(string) string) dartType {
	return dartType{t, read, func(v string) string { return v }}
}

func (s *shapes) dartTypeOf(e ast.Expr) (dartType, bool) {
	switch t := e.(type) {
	case *ast.StarExpr:
		dt, _ := s.dartTypeOf(t.X)
		return dt, true
	case *ast.ArrayType:
		item, _ := s.dartTypeOf(t.Elt)
		return dartType{
			"List<" + item.typ + ">",
			func(v string) string { return fmt.Sprintf("[for (final e in %s as List) %s]", v, item.read("e")) },
			func(v string) string { return fmt.Sprintf("[for (final e in %s) %s]", v, item.write("e")) },
		}, false
	case *ast.MapType:
		if id, ok := t.Value.(*ast.Ident); ok && id.Name == "any" {
			return plainDart("Map<String, dynamic>", func(v string) string { return v + " as Map<String, dynamic>" }), false
		}
		value, _ := s.dartTypeOf(t.Value)
		return dartType{
			"Map<String, " + value.typ + ">",
			func(v string) string {
				return fmt.Sprintf("{for (final e in (%s as Map<String, dynamic>).entries) e.key: %s}", v, value.read("e.value"))
			},
			func(v string) string {
				return fmt.Sprintf("{for (final e in %s.entries) e.key: %s}", v, value.write("e.value"))
			},
		}, false
	case *ast.SelectorExpr:
		if s.text(t) == "json.RawMessage" {
			return plainDart("Object?", func(v string) string { return v }), false
		}
	case *ast.InterfaceType:
		return plainDart("Object?", func(v string) string { return v }), false
	case *ast.Ident:
		switch t.Name {
		case "string":
			return plainDart("String", func(v string) string { return v + " as String" }), false
		case "int64", "float64":
			return plainDart("double", func(v string) string { return "(" + v + " as num).toDouble()" }), false
		case "int":
			return plainDart("int", func(v string) string { return "(" + v + " as num).toInt()" }), false
		case "bool":
			return plainDart("bool", func(v string) string { return v + " as bool" }), false
		case "any":
			return plainDart("Object?", func(v string) string { return v }), false
		}
		d := s.byName[t.Name]
		if d == nil {
			fail(fmt.Errorf("no Dart type for %s", t.Name))
		}
		n := s.dartNameOf(d)
		if d.kind == "enum" {
			return dartType{n, func(v string) string { return n + ".fromJson(" + v + ")" }, func(v string) string { return v + ".wire" }}, false
		}
		return dartType{
			n,
			func(v string) string { return n + ".fromJson(" + v + " as Map<String, dynamic>)" },
			func(v string) string { return v + ".toJson()" },
		}, false
	}
	fail(fmt.Errorf("no Dart type for %s", s.text(e)))
	return dartType{}, false
}

type dartField_ struct{ decl, param, read, write string }

func (s *shapes) dartFields(d *decl, skip string) []dartField_ {
	var out []dartField_
	for _, f := range d.fields {
		if f.json == skip {
			continue
		}
		t, nullable := s.dartTypeOf(f.typ)
		optional := f.omit || f.null || nullable
		name := dartField(f.json)
		k := dartStr(f.json)
		df := dartField_{}
		if optional {
			df.decl = fmt.Sprintf("  final %s? %s;", t.typ, name)
			df.param = "this." + name
			df.read = fmt.Sprintf("%s: j[%s] == null ? null : %s", name, k, t.read("j["+k+"]"))
			df.write = fmt.Sprintf("if (%s != null) %s: %s", name, k, t.write(name+"!"))
		} else {
			df.decl = fmt.Sprintf("  final %s %s;", t.typ, name)
			df.param = "required this." + name
			df.read = fmt.Sprintf("%s: %s", name, t.read("j["+k+"]"))
			df.write = fmt.Sprintf("%s: %s", k, t.write(name))
		}
		out = append(out, df)
	}
	return out
}

func join[T any](xs []T, f func(T) string, sep string) string {
	parts := make([]string, len(xs))
	for i, x := range xs {
		parts[i] = f(x)
	}
	return strings.Join(parts, sep)
}

func (s *shapes) dartFile() string {
	var blocks []string
	for _, d := range s.decls {
		if d.status != "" {
			continue
		}
		n := s.dartNameOf(d)
		switch d.kind {
		case "enum":
			cases := join(d.values, func(v string) string {
				c := camel(v)
				if c == "" {
					c = "empty"
				}
				return fmt.Sprintf("  %s(%s)", c, dartStr(v))
			}, ",\n")
			blocks = append(blocks, fmt.Sprintf("enum %s {\n%s;\n\n  const %s(this.wire);\n  final String wire;\n\n  static %s fromJson(Object? v) => values.firstWhere((e) => e.wire == v, orElse: () => throw FormatException('%s: unknown value', v));\n}", n, cases, n, n, n))
		case "union":
			var cases []string
			for _, m := range s.membersOf(d.name) {
				sub := s.dartNameOf(m.decl)
				for _, v := range m.values {
					cases = append(cases, fmt.Sprintf("      %s => %s.fromJson(j),", dartStr(v), sub))
				}
			}
			blocks = append(blocks, fmt.Sprintf("/// Told apart by `%s`; switch over the subclasses.\nsealed class %s {\n  const %s();\n\n  factory %s.fromJson(Map<String, dynamic> j) => switch (j[%s]) {\n%s\n      final other => throw FormatException('%s: unknown %s', other),\n    };\n\n  Map<String, dynamic> toJson();\n}", d.tag, n, n, n, dartStr(d.tag), strings.Join(cases, "\n"), n, d.tag))
		case "struct":
			if len(d.members) == 0 {
				fields := s.dartFields(d, "")
				ctor := ""
				if len(fields) > 0 {
					ctor = "{" + join(fields, func(f dartField_) string { return f.param }, ", ") + "}"
				}
				blocks = append(blocks, fmt.Sprintf("class %s {\n  const %s(%s);\n\n  factory %s.fromJson(Map<String, dynamic> j) => %s(%s);\n\n%s\n\n  Map<String, dynamic> toJson() => {%s};\n}",
					n, n, ctor, n, n, join(fields, func(f dartField_) string { return f.read }, ", "),
					join(fields, func(f dartField_) string { return f.decl }, "\n"), join(fields, func(f dartField_) string { return f.write }, ", ")))
				continue
			}
			first := d.members[0]
			tag := s.byName[first.union].tag
			single := len(first.values) == 1
			skip := ""
			if single {
				skip = tag
			}
			fields := s.dartFields(d, skip)
			ctor := ""
			if len(fields) > 0 {
				ctor = "{" + join(fields, func(f dartField_) string { return f.param }, ", ") + "}"
			}
			writes := join(fields, func(f dartField_) string { return f.write }, ", ")
			if single {
				w := []string{dartStr(tag) + ": " + dartStr(first.values[0])}
				for _, f := range fields {
					w = append(w, f.write)
				}
				writes = strings.Join(w, ", ")
			}
			head := fmt.Sprintf("final class %s extends %s", n, s.dartNameOf(s.byName[first.union]))
			if len(d.members) > 1 {
				head += " implements " + join(d.members[1:], func(m membership) string { return s.dartNameOf(s.byName[m.union]) }, ", ")
			}
			blocks = append(blocks, fmt.Sprintf("%s {\n  const %s(%s);\n\n  factory %s.fromJson(Map<String, dynamic> j) => %s(%s);\n\n%s\n\n  @override\n  Map<String, dynamic> toJson() => {%s};\n}",
				head, n, ctor, n, n, join(fields, func(f dartField_) string { return f.read }, ", "),
				join(fields, func(f dartField_) string { return f.decl }, "\n"), writes))
		}
	}

	type group struct {
		name    string
		methods []string
	}
	var groups []*group
	byGroup := map[string]*group{}
	for _, r := range s.routes {
		g := byGroup[r.group]
		if g == nil {
			g = &group{name: r.group}
			byGroup[r.group] = g
			groups = append(groups, g)
		}
		var params, query []string
		pathParts := map[string]string{}
		names := pathParams(r.path)
		i := 0
		body := "null"
		for _, p := range r.params {
			switch {
			case p.name == "body":
				t, _ := s.dartTypeOf(p.typ)
				params = append(params, "required "+t.typ+" body")
				body = t.write("body")
			case isPointer(p.typ):
				q := queryName(p.name)
				t, _ := s.dartTypeOf(p.typ)
				f := dartField(q)
				params = append(params, t.typ+"? "+f)
				query = append(query, fmt.Sprintf("if (%s != null) %s: '${%s}'", f, dartStr(q), t.write(f+"!")))
			default:
				t, _ := s.dartTypeOf(p.typ)
				f := dartField(names[i])
				params = append(params, "required "+t.typ+" "+f)
				pathParts[names[i]] = t.write(f)
				i++
			}
		}
		url := placeholder.ReplaceAllStringFunc(r.path, func(m string) string {
			k := m[1 : len(m)-1]
			part, ok := pathParts[k]
			if !ok {
				part = dartField(k)
			}
			return "${Uri.encodeComponent((" + part + ").toString())}"
		})
		doc := ""
		if len(r.doc) > 0 {
			doc = "  /// " + strings.Join(r.doc, "\n  /// ") + "\n"
		}
		signature := ""
		if len(params) > 0 {
			signature = "{" + strings.Join(params, ", ") + "}"
		}
		call := fmt.Sprintf("_api._call(%s, '%s', query: {%s}, body: %s)", dartStr(r.method), url, strings.Join(query, ", "), body)
		var code string
		if r.result != nil {
			t, _ := s.dartTypeOf(r.result)
			code = fmt.Sprintf("%s  Future<%s> %s(%s) async {\n    final j = await %s;\n    return %s;\n  }", doc, t.typ, dartField(r.op), signature, call, t.read("j"))
		} else {
			code = fmt.Sprintf("%s  Future<void> %s(%s) async {\n    await %s;\n  }", doc, dartField(r.op), signature, call)
		}
		g.methods = append(g.methods, code)
	}
	var clients []string
	for _, g := range groups {
		clients = append(clients, fmt.Sprintf("/// The `%s` endpoints of VibeValleyApi.\nclass %sApi {\n  %sApi._(this._api);\n  final VibeValleyApi _api;\n\n%s\n}", g.name, pascal(g.name), pascal(g.name), strings.Join(g.methods, "\n\n")))
	}
	lates := join(groups, func(g *group) string {
		return fmt.Sprintf("  late final %s = %sApi._(this);", camel(g.name), pascal(g.name))
	}, "\n")
	client := `/// A refusal from the server: its tagged error (FarmRefused, VoiceUnavailable…) and reason, or the bare status.
class VibeValleyApiError implements Exception {
  VibeValleyApiError(this.status, this.tag, this.reason);
  final int status;
  final String? tag;
  final String reason;
  @override
  String toString() => reason;
}

/// The server's HTTP API (server/internal/protocol/api.go), one client per group: ` + "`api.farm.say(body: …)`" + `.
class VibeValleyApi {
  VibeValleyApi(this.base, [http.Client? client]) : _http = client ?? http.Client();

  /// http://127.0.0.1:8787 by default: the server only listens on loopback.
  final Uri base;
  final http.Client _http;

` + lates + `

  Future<Object?> _call(String method, String path, {Map<String, String> query = const {}, Object? body}) async {
    final request = http.Request(method, base.resolve(path).replace(queryParameters: query.isEmpty ? null : query));
    if (body != null) {
      request.headers['content-type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await http.Response.fromStream(await _http.send(request));
    final text = utf8.decode(response.bodyBytes);
    final decoded = text.isEmpty ? null : jsonDecode(text);
    if (response.statusCode >= 300) {
      final tag = decoded is Map && decoded['_tag'] is String ? decoded['_tag'] as String : null;
      final reason = decoded is Map && decoded['reason'] is String ? decoded['reason'] as String : '服务端答 ${response.statusCode}';
      throw VibeValleyApiError(response.statusCode, tag, reason);
    }
    return decoded;
  }

  void close() => _http.close();
}`
	header := `// Generated by server/tool/shapegen from server/internal/protocol/shapes.go and api.go. Do not edit: change those and run
// go run ./tool/shapegen in server/.
// ignore_for_file: unnecessary_cast, unnecessary_this, prefer_single_quotes, unused_element

import 'dart:convert';

import 'package:http/http.dart' as http;

SiteFrame siteFrameFromJson(String s) => SiteFrame.fromJson(jsonDecode(s) as Map<String, dynamic>);
`
	return header + "\n" + strings.Join(blocks, "\n\n") + "\n\n" + strings.Join(clients, "\n\n") + "\n\n" + client + "\n"
}
