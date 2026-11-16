package tsgen

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// SourceFile represents a single Go source file passed to the parser.
type SourceFile struct {
	Name    string
	Content []byte
}

// DeclKind classifies an exported contract declaration emitted to TypeScript.
type DeclKind int

const (
	DeclEnum DeclKind = iota
	DeclAlias
	DeclStruct
)

// Field describes a JSON-serialized field on a Go struct declaration.
type Field struct {
	JSONName string
	Type     TypeExpr
	Optional bool
	Nullable bool
}

// Decl represents an exported enum, type alias, or struct in topological order.
type Decl struct {
	Name       string
	Kind       DeclKind
	File       string
	Order      int
	EnumValues []string
	AliasType  TypeExpr
	Fields     []Field
}

// Package holds the parsed, topologically ordered contract declarations.
type Package struct {
	Name  string
	Decls []Decl
}

// TypeExpr represents a Go type expression mapped to TypeScript and Zod.
type TypeExpr interface {
	typeExpr()
}

// PrimitiveKind identifies built-in scalar contract types.
type PrimitiveKind int

const (
	PrimString PrimitiveKind = iota
	PrimInt
	PrimFloat
	PrimBool
	PrimUnknown
)

// PrimitiveType is a scalar TypeScript/Zod primitive type.
type PrimitiveType struct {
	Kind PrimitiveKind
}

func (PrimitiveType) typeExpr() {}

// BrandedIDType represents a branded entity ID imported from ../common/{shapes,schema}.
type BrandedIDType struct {
	Name string
}

func (BrandedIDType) typeExpr() {}

// NamedType references another declaration in the same contract package.
type NamedType struct {
	Name string
}

func (NamedType) typeExpr() {}

// ArrayType represents a JSON array of Elem.
type ArrayType struct {
	Elem TypeExpr
}

func (ArrayType) typeExpr() {}

// NullableType represents a nullable element type (e.g. []*Foo).
type NullableType struct {
	Elem TypeExpr
}

func (NullableType) typeExpr() {}

// MapType represents a JSON object map with string-encoded keys and Val values.
type MapType struct {
	Key TypeExpr
	Val TypeExpr
}

func (MapType) typeExpr() {}

// InlineStructType represents an anonymous struct nested inside a field.
type InlineStructType struct {
	Fields []Field
}

func (InlineStructType) typeExpr() {}

// ParseDir parses all non-test Go files in dir in deterministic filename order.
func ParseDir(dir string) (*Package, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read contract dir %q: %w", dir, err)
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go") {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	if len(names) == 0 {
		return nil, fmt.Errorf("no non-test Go files found in %q", dir)
	}
	files := make([]SourceFile, 0, len(names))
	for _, name := range names {
		full := filepath.Join(dir, name)
		data, err := os.ReadFile(full)
		if err != nil {
			return nil, fmt.Errorf("read %q: %w", full, err)
		}
		files = append(files, SourceFile{Name: name, Content: data})
	}
	return ParseFiles(files)
}

type rawTypeDecl struct {
	name  string
	file  string
	order int
	spec  *ast.TypeSpec
}

type rawConstDecl struct {
	file string
	spec *ast.ValueSpec
}

// ParseFiles parses a set of Go source files and returns topologically sorted declarations.
func ParseFiles(files []SourceFile) (*Package, error) {
	sortedFiles := slices.Clone(files)
	slices.SortFunc(sortedFiles, func(a, b SourceFile) int {
		return strings.Compare(a.Name, b.Name)
	})

	fset := token.NewFileSet()
	parsed := make([]*ast.File, 0, len(sortedFiles))
	pkgName := ""

	for _, sf := range sortedFiles {
		af, err := parser.ParseFile(fset, sf.Name, sf.Content, 0)
		if err != nil {
			return nil, fmt.Errorf("parse %q: %w", sf.Name, err)
		}
		if pkgName == "" {
			pkgName = af.Name.Name
		} else if af.Name.Name != pkgName {
			return nil, fmt.Errorf("mixed packages in dir: %q has %q, expected %q", sf.Name, af.Name.Name, pkgName)
		}
		parsed = append(parsed, af)
	}

	rawTypes := make(map[string]rawTypeDecl)
	var typeList []rawTypeDecl
	var constList []rawConstDecl

	order := 0
	for i, af := range parsed {
		fname := sortedFiles[i].Name
		for _, decl := range af.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok {
				continue
			}
			switch gd.Tok {
			case token.TYPE:
				for _, spec := range gd.Specs {
					ts, ok := spec.(*ast.TypeSpec)
					if !ok || !ast.IsExported(ts.Name.Name) {
						continue
					}
					if ts.TypeParams != nil && len(ts.TypeParams.List) > 0 {
						return nil, fmt.Errorf("%s: generic type %s is not supported", fname, ts.Name.Name)
					}
					if _, exists := rawTypes[ts.Name.Name]; exists {
						return nil, fmt.Errorf("%s: duplicate exported type %s", fname, ts.Name.Name)
					}
					rd := rawTypeDecl{
						name:  ts.Name.Name,
						file:  fname,
						order: order,
						spec:  ts,
					}
					order++
					rawTypes[ts.Name.Name] = rd
					typeList = append(typeList, rd)
				}
			case token.CONST:
				for _, spec := range gd.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					constList = append(constList, rawConstDecl{file: fname, spec: vs})
				}
			}
		}
	}

	enumValues := collectEnumConstants(rawTypes, constList)

	decls := make([]Decl, 0, len(typeList))
	knownTypes := make(map[string]rawTypeDecl, len(rawTypes))
	for _, rd := range typeList {
		if _, isIface := rd.spec.Type.(*ast.InterfaceType); isIface {
			continue
		}
		knownTypes[rd.name] = rd
	}

	for _, rd := range typeList {
		if _, isIface := rd.spec.Type.(*ast.InterfaceType); isIface {
			continue
		}
		d, err := resolveDecl(rd, knownTypes, enumValues[rd.name])
		if err != nil {
			return nil, err
		}
		decls = append(decls, d)
	}

	sortedDecls, err := topoSortDecls(decls)
	if err != nil {
		return nil, err
	}

	return &Package{Name: pkgName, Decls: sortedDecls}, nil
}

func isUnderlyingString(expr ast.Expr) bool {
	expr = unwrapParens(expr)
	id, ok := expr.(*ast.Ident)
	return ok && id.Name == "string"
}

func collectEnumConstants(rawTypes map[string]rawTypeDecl, consts []rawConstDecl) map[string][]string {
	out := make(map[string][]string)
	for _, c := range consts {
		vs := c.spec
		explicitType := ""
		if vs.Type != nil {
			if id, ok := unwrapParens(vs.Type).(*ast.Ident); ok {
				if rd, exists := rawTypes[id.Name]; exists && isUnderlyingString(rd.spec.Type) {
					explicitType = id.Name
				}
			}
		}
		for i, nameIdent := range vs.Names {
			if !ast.IsExported(nameIdent.Name) || i >= len(vs.Values) {
				continue
			}
			valExpr := unwrapParens(vs.Values[i])
			targetType := explicitType
			if targetType == "" {
				if call, ok := valExpr.(*ast.CallExpr); ok && len(call.Args) == 1 {
					if fn, ok := unwrapParens(call.Fun).(*ast.Ident); ok {
						if rd, exists := rawTypes[fn.Name]; exists && isUnderlyingString(rd.spec.Type) {
							targetType = fn.Name
							valExpr = call.Args[0]
						}
					}
				}
			}
			if targetType == "" {
				continue
			}
			lit, ok := evalStringLit(valExpr)
			if !ok {
				continue
			}
			out[targetType] = append(out[targetType], lit)
		}
	}
	return out
}

func evalStringLit(expr ast.Expr) (string, bool) {
	expr = unwrapParens(expr)
	switch e := expr.(type) {
	case *ast.BasicLit:
		if e.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(e.Value)
		if err != nil {
			return "", false
		}
		return s, true
	case *ast.BinaryExpr:
		if e.Op != token.ADD {
			return "", false
		}
		lhs, okL := evalStringLit(e.X)
		rhs, okR := evalStringLit(e.Y)
		if !okL || !okR {
			return "", false
		}
		return lhs + rhs, true
	default:
		return "", false
	}
}

func unwrapParens(expr ast.Expr) ast.Expr {
	for {
		p, ok := expr.(*ast.ParenExpr)
		if !ok {
			return expr
		}
		expr = p.X
	}
}

func resolveDecl(rd rawTypeDecl, known map[string]rawTypeDecl, enumVals []string) (Decl, error) {
	if len(enumVals) > 0 && isUnderlyingString(rd.spec.Type) {
		return Decl{
			Name:       rd.name,
			Kind:       DeclEnum,
			File:       rd.file,
			Order:      rd.order,
			EnumValues: enumVals,
		}, nil
	}

	if st, ok := unwrapParens(rd.spec.Type).(*ast.StructType); ok {
		isBoundaryInput := strings.HasSuffix(rd.name, "Request") || strings.HasSuffix(rd.name, "Input")
		fields, err := resolveStructFields(rd.file, rd.name, !isBoundaryInput, st, known)
		if err != nil {
			return Decl{}, err
		}
		return Decl{
			Name:   rd.name,
			Kind:   DeclStruct,
			File:   rd.file,
			Order:  rd.order,
			Fields: fields,
		}, nil
	}

	aliasType, err := resolveTypeExpr(rd.file, rd.name, rd.spec.Type, known)
	if err != nil {
		return Decl{}, err
	}
	return Decl{
		Name:      rd.name,
		Kind:      DeclAlias,
		File:      rd.file,
		Order:     rd.order,
		AliasType: aliasType,
	}, nil
}

func resolveStructFields(file string, owner string, brandIDs bool, st *ast.StructType, known map[string]rawTypeDecl) ([]Field, error) {
	if st.Fields == nil {
		return nil, nil
	}
	var fields []Field
	for _, f := range st.Fields.List {
		tagName, omit, skip, err := parseJSONTag(f.Tag)
		if err != nil {
			return nil, fmt.Errorf("%s (%s): %w", file, owner, err)
		}
		if skip {
			continue
		}

		isPtr, elemExpr := unwrapPointers(f.Type)

		if len(f.Names) == 0 {
			embeddedName := embeddedTypeName(elemExpr)
			if embeddedName == "" {
				return nil, fmt.Errorf("%s (%s): unsupported embedded field", file, owner)
			}
			if tagName == "" {
				rd, ok := known[embeddedName]
				if !ok {
					return nil, fmt.Errorf("%s (%s): embedded type %s is not an exported struct in this package", file, owner, embeddedName)
				}
				est, ok := unwrapParens(rd.spec.Type).(*ast.StructType)
				if !ok {
					return nil, fmt.Errorf("%s (%s): embedded type %s is not a struct", file, owner, embeddedName)
				}
				embeddedFields, err := resolveStructFields(rd.file, embeddedName, brandIDs, est, known)
				if err != nil {
					return nil, err
				}
				fields = append(fields, embeddedFields...)
				continue
			}
			if !ast.IsExported(embeddedName) {
				continue
			}
			typ, err := resolveTypeExprForField(file, owner, tagName, brandIDs, elemExpr, known)
			if err != nil {
				return nil, err
			}
			fields = append(fields, Field{
				JSONName: tagName,
				Type:     typ,
				Optional: omit,
				Nullable: isPtr && !omit,
			})
			continue
		}

		for _, nameIdent := range f.Names {
			if !ast.IsExported(nameIdent.Name) {
				continue
			}
			jsonName := tagName
			if jsonName == "" {
				jsonName = nameIdent.Name
			}
			typ, err := resolveTypeExprForField(file, owner, jsonName, brandIDs, elemExpr, known)
			if err != nil {
				return nil, err
			}
			fields = append(fields, Field{
				JSONName: jsonName,
				Type:     typ,
				Optional: omit,
				Nullable: isPtr && !omit,
			})
		}
	}
	return fields, nil
}

func resolveTypeExprForField(file string, owner string, jsonName string, brandIDs bool, expr ast.Expr, known map[string]rawTypeDecl) (TypeExpr, error) {
	if brandIDs {
		if brand, ok := brandedIDForField(jsonName); ok {
			unwrapped := unwrapParens(expr)
			if id, ok := unwrapped.(*ast.Ident); ok && id.Name == "string" {
				return BrandedIDType{Name: brand}, nil
			}
			if arr, ok := unwrapped.(*ast.ArrayType); ok {
				if id, ok := unwrapParens(arr.Elt).(*ast.Ident); ok && id.Name == "string" {
					return ArrayType{Elem: BrandedIDType{Name: brand}}, nil
				}
			}
		}
	}
	return resolveTypeExprWithBranding(file, owner, brandIDs, expr, known)
}

func brandedIDForField(jsonName string) (string, bool) {
	switch jsonName {
	case "issue", "issueId", "blockedBy":
		return "IssueId", true
	case "session", "sessionId", "sessionIds":
		return "SessionId", true
	case "artifact", "artifactId":
		return "ArtifactId", true
	case "blockId":
		return "BlockId", true
	case "suggestion", "suggestionId":
		return "SuggestionId", true
	case "messageId":
		return "MessageId", true
	default:
		return "", false
	}
}

func unwrapPointers(expr ast.Expr) (bool, ast.Expr) {
	isPtr := false
	for {
		expr = unwrapParens(expr)
		star, ok := expr.(*ast.StarExpr)
		if !ok {
			return isPtr, expr
		}
		isPtr = true
		expr = star.X
	}
}

func embeddedTypeName(expr ast.Expr) string {
	expr = unwrapParens(expr)
	if id, ok := expr.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

func parseJSONTag(tagLit *ast.BasicLit) (name string, omit bool, skip bool, err error) {
	if tagLit == nil {
		return "", false, false, nil
	}
	raw, err := strconv.Unquote(tagLit.Value)
	if err != nil {
		return "", false, false, fmt.Errorf("invalid struct tag %s: %w", tagLit.Value, err)
	}
	val, ok := reflect.StructTag(raw).Lookup("json")
	if !ok {
		return "", false, false, nil
	}
	if val == "-" {
		return "", false, true, nil
	}
	parts := strings.Split(val, ",")
	name = parts[0]
	for _, opt := range parts[1:] {
		if opt == "omitempty" || opt == "omitzero" {
			omit = true
		}
	}
	return name, omit, false, nil
}

func resolveTypeExpr(file string, owner string, expr ast.Expr, known map[string]rawTypeDecl) (TypeExpr, error) {
	return resolveTypeExprWithBranding(file, owner, false, expr, known)
}

func resolveTypeExprWithBranding(file string, owner string, brandIDs bool, expr ast.Expr, known map[string]rawTypeDecl) (TypeExpr, error) {
	expr = unwrapParens(expr)
	switch e := expr.(type) {
	case *ast.Ident:
		switch e.Name {
		case "string":
			return PrimitiveType{Kind: PrimString}, nil
		case "bool":
			return PrimitiveType{Kind: PrimBool}, nil
		case "int", "int8", "int16", "int32", "int64",
			"uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
			"byte", "rune":
			return PrimitiveType{Kind: PrimInt}, nil
		case "float32", "float64":
			return PrimitiveType{Kind: PrimFloat}, nil
		case "any":
			return PrimitiveType{Kind: PrimUnknown}, nil
		default:
			if _, ok := known[e.Name]; ok {
				return NamedType{Name: e.Name}, nil
			}
			return nil, fmt.Errorf("%s (%s): unsupported type reference %q", file, owner, e.Name)
		}
	case *ast.InterfaceType:
		if e.Methods == nil || len(e.Methods.List) == 0 {
			return PrimitiveType{Kind: PrimUnknown}, nil
		}
		return nil, fmt.Errorf("%s (%s): non-empty interface type is not supported", file, owner)
	case *ast.SelectorExpr:
		if pkg, ok := unwrapParens(e.X).(*ast.Ident); ok {
			switch pkg.Name + "." + e.Sel.Name {
			case "json.RawMessage":
				return PrimitiveType{Kind: PrimUnknown}, nil
			case "time.Time":
				return PrimitiveType{Kind: PrimString}, nil
			case "time.Duration":
				return PrimitiveType{Kind: PrimInt}, nil
			}
		}
		return nil, fmt.Errorf("%s (%s): unsupported external selector type %s", file, owner, e.Sel.Name)
	case *ast.StarExpr:
		inner, err := resolveTypeExprWithBranding(file, owner, brandIDs, e.X, known)
		if err != nil {
			return nil, err
		}
		if _, alreadyNullable := inner.(NullableType); alreadyNullable {
			return inner, nil
		}
		return NullableType{Elem: inner}, nil
	case *ast.ArrayType:
		if e.Len == nil {
			if id, ok := unwrapParens(e.Elt).(*ast.Ident); ok && (id.Name == "byte" || id.Name == "uint8") {
				// encoding/json marshals []byte as a base64-encoded JSON string.
				return PrimitiveType{Kind: PrimString}, nil
			}
		}
		elem, err := resolveTypeExprWithBranding(file, owner, brandIDs, e.Elt, known)
		if err != nil {
			return nil, err
		}
		return ArrayType{Elem: elem}, nil
	case *ast.MapType:
		key, err := resolveTypeExprWithBranding(file, owner, brandIDs, e.Key, known)
		if err != nil {
			return nil, err
		}
		val, err := resolveTypeExprWithBranding(file, owner, brandIDs, e.Value, known)
		if err != nil {
			return nil, err
		}
		return MapType{Key: key, Val: val}, nil
	case *ast.StructType:
		fields, err := resolveStructFields(file, owner, brandIDs, e, known)
		if err != nil {
			return nil, err
		}
		return InlineStructType{Fields: fields}, nil
	default:
		return nil, fmt.Errorf("%s (%s): unsupported AST type %T", file, owner, expr)
	}
}

func collectDeps(expr TypeExpr, out map[string]struct{}) {
	switch t := expr.(type) {
	case NamedType:
		out[t.Name] = struct{}{}
	case ArrayType:
		collectDeps(t.Elem, out)
	case NullableType:
		collectDeps(t.Elem, out)
	case MapType:
		collectDeps(t.Key, out)
		collectDeps(t.Val, out)
	case InlineStructType:
		for _, f := range t.Fields {
			collectDeps(f.Type, out)
		}
	}
}

func topoSortDecls(decls []Decl) ([]Decl, error) {
	idxByName := make(map[string]int, len(decls))
	for i, d := range decls {
		idxByName[d.Name] = i
	}

	inDegree := make([]int, len(decls))
	dependents := make([][]int, len(decls))

	for i, d := range decls {
		depSet := make(map[string]struct{})
		switch d.Kind {
		case DeclAlias:
			collectDeps(d.AliasType, depSet)
		case DeclStruct:
			for _, f := range d.Fields {
				collectDeps(f.Type, depSet)
			}
		}
		delete(depSet, d.Name)
		depNames := make([]string, 0, len(depSet))
		for name := range depSet {
			depNames = append(depNames, name)
		}
		slices.Sort(depNames)
		for _, name := range depNames {
			depIdx, ok := idxByName[name]
			if !ok {
				continue
			}
			inDegree[i]++
			dependents[depIdx] = append(dependents[depIdx], i)
		}
	}

	var ready []int
	for i, deg := range inDegree {
		if deg == 0 {
			ready = append(ready, i)
		}
	}

	sorted := make([]Decl, 0, len(decls))
	for len(ready) > 0 {
		slices.Sort(ready)
		curr := ready[0]
		ready = ready[1:]
		sorted = append(sorted, decls[curr])
		for _, next := range dependents[curr] {
			inDegree[next]--
			if inDegree[next] == 0 {
				ready = append(ready, next)
			}
		}
	}

	if len(sorted) != len(decls) {
		var stuck []string
		for i, deg := range inDegree {
			if deg > 0 {
				stuck = append(stuck, decls[i].Name)
			}
		}
		slices.Sort(stuck)
		return nil, fmt.Errorf("cyclic contract declaration dependency involving: %s", strings.Join(stuck, ", "))
	}

	return sorted, nil
}
