package artifact

import (
	"fmt"
	"html"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/evanw/esbuild/pkg/api"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// CompileRequest describes a multi-file virtual-FS TSX/JSX/TS/JS/CSS bundle to compile.
type CompileRequest struct {
	Entry   string                       `json:"entry"`
	Files   map[string]string            `json:"files"`
	Title   string                       `json:"title,omitempty"`
	Display contract.ArtifactDisplayMode `json:"display,omitempty"`
	Minify  bool                         `json:"minify,omitempty"`
}

// CompileResult holds the self-contained HTML artifact produced by in-process esbuild compilation.
type CompileResult struct {
	HTML         string        `json:"html"`
	JS           string        `json:"js"`
	CSS          string        `json:"css"`
	SHA256       string        `json:"sha256"`
	SourceSHA256 string        `json:"sourceSha256"`
	Duration     time.Duration `json:"duration"`
	Warnings     []Diagnostic  `json:"warnings,omitempty"`
}

var resolveExts = []string{"", ".tsx", ".ts", ".jsx", ".js", ".css", ".json", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"}

var builtinReactShims = map[string]string{
	"react": `
export const Fragment = Symbol.for("vv.fragment");
export function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && typeof c !== "boolean");
  return { type, props: Object.assign({}, props || {}, { children: flat }) };
}
export function useState(init) { return [typeof init === "function" ? init() : init, () => {}]; }
export function useEffect() {}
export function useMemo(fn) { return fn(); }
export function useRef(cur) { return { current: cur }; }
export function useCallback(fn) { return fn; }
export default { Fragment, createElement, useState, useEffect, useMemo, useRef, useCallback };
`,
	"react/jsx-runtime": `
import { Fragment, createElement } from "react";
export { Fragment };
export function jsx(type, props) {
  const ch = props && "children" in props ? (Array.isArray(props.children) ? props.children : [props.children]) : [];
  return createElement(type, props, ...ch);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
`,
	"react/jsx-dev-runtime": `
export { Fragment, jsx, jsxs, jsxDEV } from "react/jsx-runtime";
`,
	"react-dom": `
export function renderNode(node) {
  if (node === null || node === undefined || typeof node === "boolean") return document.createTextNode("");
  if (typeof node === "string" || typeof node === "number") return document.createTextNode(String(node));
  if (Array.isArray(node)) {
    const f = document.createDocumentFragment();
    for (const item of node) f.appendChild(renderNode(item));
    return f;
  }
  if (typeof node.type === "function") return renderNode(node.type(node.props || {}));
  const el = typeof node.type === "symbol" ? document.createDocumentFragment() : document.createElement(String(node.type));
  if (el instanceof Element && node.props) {
    for (const [k, v] of Object.entries(node.props)) {
      if (k === "children" || v === undefined || v === null) continue;
      if (k === "className") el.setAttribute("class", String(v));
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === "boolean") { if (v) el.setAttribute(k, ""); }
      else el.setAttribute(k, String(v));
    }
  }
  const children = (node.props && node.props.children) || [];
  for (const child of Array.isArray(children) ? children : [children]) el.appendChild(renderNode(child));
  return el;
}
export function createRoot(container) {
  return {
    render(vnode) {
      if (!container) return;
      container.innerHTML = "";
      container.appendChild(renderNode(vnode));
    },
  };
}
export default { createRoot };
`,
	"react-dom/client": `
export { createRoot } from "react-dom";
`,
}

// CompileBundle compiles an in-memory multi-file TSX/JSX/CSS bundle using esbuild's Go API.
// Syntax and import errors are returned as *CompileError with exact file, line, column, and message.
func CompileBundle(req CompileRequest) (CompileResult, error) {
	start := time.Now()

	display := req.Display
	if display == "" {
		display = contract.ArtifactDisplayPage
	}
	if !IsValidDisplayMode(display) {
		return CompileResult{}, fmt.Errorf("%w: %q", ErrInvalidDisplayMode, display)
	}

	vfs, err := normalizeVirtualFiles(req.Files)
	if err != nil {
		return CompileResult{}, &CompileError{
			Diagnostics: []Diagnostic{{Message: err.Error()}},
			DurationMs:  time.Since(start).Milliseconds(),
		}
	}
	if len(vfs) == 0 {
		return CompileResult{}, &CompileError{
			Diagnostics: []Diagnostic{{Message: "bundle contains no source files"}},
			DurationMs:  time.Since(start).Milliseconds(),
		}
	}

	entry, ok := resolveEntryPoint(vfs, req.Entry)
	if !ok {
		return CompileResult{}, &CompileError{
			Diagnostics: []Diagnostic{{
				File:    req.Entry,
				Message: fmt.Sprintf("entry file %q not found in virtual files", req.Entry),
			}},
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	plugin := api.Plugin{
		Name: "vibevalley-vfs",
		Setup: func(build api.PluginBuild) {
			build.OnResolve(api.OnResolveOptions{Filter: `.*`}, func(args api.OnResolveArgs) (api.OnResolveResult, error) {
				if args.Kind == api.ResolveEntryPoint {
					if resolved, found := resolveVFSFile(vfs, normalizeVFSPath(args.Path)); found {
						return api.OnResolveResult{Path: resolved, Namespace: "vfs"}, nil
					}
					return api.OnResolveResult{
						Errors: []api.Message{{Text: fmt.Sprintf("entry point %q not found", args.Path)}},
					}, nil
				}

				if strings.HasPrefix(args.Path, "./") || strings.HasPrefix(args.Path, "../") || strings.HasPrefix(args.Path, "/") {
					var target string
					if strings.HasPrefix(args.Path, "/") {
						target = strings.TrimPrefix(path.Clean(args.Path), "/")
					} else {
						baseDir := path.Dir(normalizeVFSPath(args.Importer))
						joined := path.Join(baseDir, args.Path)
						if joined == ".." || strings.HasPrefix(joined, "../") {
							return api.OnResolveResult{
								Errors: []api.Message{{Text: fmt.Sprintf("import %q escapes virtual bundle root", args.Path)}},
							}, nil
						}
						target = joined
					}
					if resolved, found := resolveVFSFile(vfs, target); found {
						return api.OnResolveResult{Path: resolved, Namespace: "vfs"}, nil
					}
					return api.OnResolveResult{
						Errors: []api.Message{{Text: fmt.Sprintf("could not resolve %q", args.Path)}},
					}, nil
				}

				if resolved, found := resolveVFSFile(vfs, normalizeVFSPath(args.Path)); found {
					return api.OnResolveResult{Path: resolved, Namespace: "vfs"}, nil
				}
				if _, isShim := builtinReactShims[args.Path]; isShim {
					return api.OnResolveResult{Path: args.Path, Namespace: "vv-shim"}, nil
				}
				return api.OnResolveResult{
					Errors: []api.Message{{Text: fmt.Sprintf("could not resolve %q in isolated virtual bundle", args.Path)}},
				}, nil
			})

			build.OnLoad(api.OnLoadOptions{Filter: `.*`, Namespace: "vfs"}, func(args api.OnLoadArgs) (api.OnLoadResult, error) {
				contents, exists := vfs[args.Path]
				if !exists {
					return api.OnLoadResult{
						Errors: []api.Message{{Text: fmt.Sprintf("virtual file %q not found", args.Path)}},
					}, nil
				}
				loader := loaderForPath(args.Path)
				return api.OnLoadResult{
					Contents: &contents,
					Loader:   loader,
				}, nil
			})

			build.OnLoad(api.OnLoadOptions{Filter: `.*`, Namespace: "vv-shim"}, func(args api.OnLoadArgs) (api.OnLoadResult, error) {
				contents, exists := builtinReactShims[args.Path]
				if !exists {
					return api.OnLoadResult{
						Errors: []api.Message{{Text: fmt.Sprintf("missing virtual runtime %q", args.Path)}},
					}, nil
				}
				return api.OnLoadResult{
					Contents: &contents,
					Loader:   api.LoaderJS,
				}, nil
			})
		},
	}

	res := api.Build(api.BuildOptions{
		EntryPoints:       []string{entry},
		Bundle:            true,
		Write:             false,
		Outdir:            "out",
		EntryNames:        "bundle",
		Format:            api.FormatIIFE,
		Platform:          api.PlatformBrowser,
		Target:            api.ES2022,
		JSX:               api.JSXAutomatic,
		JSXImportSource:   "react",
		MinifyWhitespace:  req.Minify,
		MinifyIdentifiers: req.Minify,
		MinifySyntax:      req.Minify,
		LogLevel:          api.LogLevelSilent,
		Plugins:           []api.Plugin{plugin},
	})

	elapsed := time.Since(start)

	if len(res.Errors) > 0 {
		return CompileResult{}, &CompileError{
			Diagnostics: mapEsbuildMessages(res.Errors),
			DurationMs:  elapsed.Milliseconds(),
		}
	}

	var jsOut, cssOut string
	for _, outFile := range res.OutputFiles {
		switch {
		case strings.HasSuffix(outFile.Path, ".css"):
			cssOut += string(outFile.Contents)
		case strings.HasSuffix(outFile.Path, ".js"):
			jsOut += string(outFile.Contents)
		}
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "Artifact Preview"
	}
	wrappedHTML := wrapCompiledHTML(title, display, cssOut, jsOut)

	return CompileResult{
		HTML:         wrappedHTML,
		JS:           jsOut,
		CSS:          cssOut,
		SHA256:       SumSHA256([]byte(wrappedHTML)),
		SourceSHA256: hashCanonicalSourceFiles(vfs, entry, display, title),
		Duration:     elapsed,
		Warnings:     mapEsbuildMessages(res.Warnings),
	}, nil
}

func normalizeVirtualFiles(files map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(files))
	for rawPath, body := range files {
		p := normalizeVFSPath(rawPath)
		if p == "" || p == "." || p == ".." || strings.HasPrefix(p, "../") || strings.ContainsRune(rawPath, 0) {
			return nil, fmt.Errorf("%w: invalid virtual path %q", ErrInvalidBundle, rawPath)
		}
		out[p] = body
	}
	return out, nil
}

func normalizeVFSPath(raw string) string {
	s := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	s = strings.TrimPrefix(s, "vfs:")
	s = strings.TrimLeft(s, "/")
	if s == "" {
		return ""
	}
	cleaned := path.Clean(s)
	return strings.TrimPrefix(cleaned, "./")
}

func resolveEntryPoint(vfs map[string]string, requested string) (string, bool) {
	if strings.TrimSpace(requested) != "" {
		return resolveVFSFile(vfs, normalizeVFSPath(requested))
	}
	for _, candidate := range []string{"index.tsx", "src/index.tsx", "App.tsx", "src/App.tsx", "main.tsx", "src/main.tsx", "index.ts", "index.jsx", "index.js"} {
		if resolved, ok := resolveVFSFile(vfs, candidate); ok {
			return resolved, true
		}
	}
	if len(vfs) == 1 {
		for k := range vfs {
			return k, true
		}
	}
	return "", false
}

func resolveVFSFile(vfs map[string]string, base string) (string, bool) {
	if base == "" {
		return "", false
	}
	for _, ext := range resolveExts {
		candidate := base + ext
		if _, ok := vfs[candidate]; ok {
			return candidate, true
		}
	}
	return "", false
}

func loaderForPath(p string) api.Loader {
	switch strings.ToLower(path.Ext(p)) {
	case ".tsx":
		return api.LoaderTSX
	case ".ts", ".mts", ".cts":
		return api.LoaderTS
	case ".jsx":
		return api.LoaderJSX
	case ".js", ".mjs", ".cjs":
		return api.LoaderJS
	case ".css":
		return api.LoaderCSS
	case ".json":
		return api.LoaderJSON
	case ".svg":
		return api.LoaderDataURL
	default:
		return api.LoaderText
	}
}

func mapEsbuildMessages(msgs []api.Message) []Diagnostic {
	if len(msgs) == 0 {
		return nil
	}
	out := make([]Diagnostic, 0, len(msgs))
	for _, m := range msgs {
		d := Diagnostic{
			Message: m.Text,
		}
		if m.Location != nil {
			d.File = strings.TrimPrefix(m.Location.File, "vfs:")
			d.Line = m.Location.Line
			if m.Location.Line > 0 {
				// esbuild Location.Column is 0-based byte offset; expose 1-based column alongside 1-based line.
				d.Column = m.Location.Column + 1
			}
			d.Length = m.Location.Length
			d.LineText = m.Location.LineText
			d.Suggestion = m.Location.Suggestion
		}
		out = append(out, d)
	}
	return out
}

func hashCanonicalSourceFiles(vfs map[string]string, entry string, display contract.ArtifactDisplayMode, title string) string {
	keys := make([]string, 0, len(vfs))
	for k := range vfs {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var sb strings.Builder
	sb.WriteString("entry:" + entry + "\n")
	sb.WriteString("display:" + string(display) + "\n")
	sb.WriteString("title:" + title + "\n")
	for _, k := range keys {
		fmt.Fprintf(&sb, "file:%s\nlen:%d\n%s\n", k, len(vfs[k]), vfs[k])
	}
	return SumSHA256([]byte(sb.String()))
}

func wrapCompiledHTML(title string, display contract.ArtifactDisplayMode, cssText, jsText string) string {
	// Escape closing script tags inside bundled JS so string literals cannot terminate the script element.
	safeJS := strings.ReplaceAll(jsText, "</script", `<\/script`)
	safeJS = strings.ReplaceAll(safeJS, "</SCRIPT", `<\/SCRIPT`)
	safeCSS := strings.ReplaceAll(cssText, "</style", `<\/style`)
	safeCSS = strings.ReplaceAll(safeCSS, "</STYLE", `<\/STYLE`)

	var sb strings.Builder
	sb.WriteString("<!doctype html>\n<html lang=\"en\" data-vv-display=\"")
	sb.WriteString(html.EscapeString(string(display)))
	sb.WriteString("\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>")
	sb.WriteString(html.EscapeString(title))
	sb.WriteString("</title>\n<style>:root{--vv-page:#fcfcfb;--vv-side:#f6f5f3;--vv-ink:#1c1917;--vv-muted:#5e5852;--vv-accent:#4d7a2a}html,body{margin:0;padding:0;min-height:100%;background:var(--vv-page);color:var(--vv-ink);font-family:system-ui,sans-serif}</style>\n")
	if safeCSS != "" {
		sb.WriteString("<style>\n")
		sb.WriteString(safeCSS)
		sb.WriteString("\n</style>\n")
	}
	sb.WriteString("</head>\n<body>\n<div id=\"root\"></div>\n")
	if safeJS != "" {
		sb.WriteString("<script>\n")
		sb.WriteString(safeJS)
		sb.WriteString("\n</script>\n")
	}
	sb.WriteString("</body>\n</html>\n")
	return sb.String()
}
