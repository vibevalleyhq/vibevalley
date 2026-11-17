package main

import (
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

const defaultWebScheme = "vibe"

//go:embed web_fallback.html
var embeddedFallbackFS embed.FS

// WebViewConfig configures the custom-scheme asset handler and MyGo workbench window.
type WebViewConfig struct {
	Scheme     string
	Host       string
	DiskDir    string
	EmbeddedFS fs.FS
	ServerURL  string
	PreloadJS  string
}

var extraMimeTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".htm":   "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".wasm":  "application/wasm",
}

// ResolveBundledWebDist resolves the built frontend directory from an explicit override,
// a macOS .app bundle's Contents/Resources/web directory, or a repository apps/web/dist checkout.
func ResolveBundledWebDist(explicitDir, execPath, cwd string) string {
	if trimmed := strings.TrimSpace(explicitDir); trimmed != "" {
		return trimmed
	}
	var candidates []string
	if trimmedExe := strings.TrimSpace(execPath); trimmedExe != "" {
		candidates = append(candidates, filepath.Clean(filepath.Join(filepath.Dir(trimmedExe), "..", "Resources", "web")))
	}
	if trimmedCwd := strings.TrimSpace(cwd); trimmedCwd != "" {
		candidates = append(candidates, filepath.Clean(filepath.Join(trimmedCwd, "apps", "web", "dist")))
	}
	for _, candidate := range candidates {
		if hasWebDistIndex(candidate) {
			return candidate
		}
	}
	return ""
}

func hasWebDistIndex(dir string) bool {
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	idx, err := os.Stat(filepath.Join(dir, "index.html"))
	return err == nil && !idx.IsDir()
}

// NewWebAssetFS resolves the frontend fs.FS from diskDir (when provided), embedded, or
// the built-in fallback shell. An explicit non-existent diskDir returns an error.
func NewWebAssetFS(diskDir string, embedded fs.FS) (fs.FS, error) {
	if trimmed := strings.TrimSpace(diskDir); trimmed != "" {
		abs, err := filepath.Abs(trimmed)
		if err != nil {
			return nil, fmt.Errorf("web assets: resolve %q: %w", trimmed, err)
		}
		info, err := os.Stat(abs)
		if err != nil {
			return nil, fmt.Errorf("web assets: stat %q: %w", abs, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("web assets: %q is not a directory", abs)
		}
		if _, err := os.Stat(filepath.Join(abs, "index.html")); err != nil {
			return nil, fmt.Errorf("web assets: missing index.html in %q: %w", abs, err)
		}
		return os.DirFS(abs), nil
	}
	if embedded != nil {
		return embedded, nil
	}
	return embeddedFallbackFS, nil
}

// NewWebAssetHandler returns an http.Handler serving apps/web/dist assets over a custom
// MyGo scheme with SPA routing fallback and strict content-type / path traversal guards.
func NewWebAssetHandler(fsys fs.FS) (http.Handler, error) {
	if fsys == nil {
		return nil, errors.New("web assets: nil fs.FS")
	}
	indexName := "index.html"
	if _, err := fs.Stat(fsys, indexName); err != nil {
		if _, fbErr := fs.Stat(fsys, "web_fallback.html"); fbErr == nil {
			indexName = "web_fallback.html"
		} else {
			return nil, fmt.Errorf("web assets: missing index.html: %w", err)
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
			return
		}
		if strings.Contains(r.URL.Path, "\x00") || strings.Contains(r.URL.Path, "\\") {
			http.NotFound(w, r)
			return
		}

		clean := path.Clean("/" + r.URL.Path)
		rel := strings.TrimPrefix(clean, "/")
		if rel == "" || rel == "." {
			rel = indexName
		}

		if serveStaticFile(w, r, fsys, rel) {
			return
		}
		// Only extensionless client routes fall back to index.html; missing JS/CSS/media stay 404.
		if path.Ext(rel) == "" {
			if serveStaticFile(w, r, fsys, indexName) {
				return
			}
		}
		http.NotFound(w, r)
	}), nil
}

func serveStaticFile(w http.ResponseWriter, r *http.Request, fsys fs.FS, rel string) bool {
	info, err := fs.Stat(fsys, rel)
	if err != nil {
		return false
	}
	if info.IsDir() {
		rel = path.Join(rel, "index.html")
		info, err = fs.Stat(fsys, rel)
		if err != nil || info.IsDir() {
			return false
		}
	}

	f, err := fsys.Open(rel)
	if err != nil {
		return false
	}
	defer f.Close()

	ext := strings.ToLower(path.Ext(rel))
	if ctype, ok := extraMimeTypes[ext]; ok {
		w.Header().Set("Content-Type", ctype)
	} else if ctype := mime.TypeByExtension(ext); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(rel, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}

	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, path.Base(rel), info.ModTime(), rs)
		return true
	}
	data, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return true
	}
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
	return true
}

// RegisterWebProtocol registers handler under scheme with MyGo's custom URL protocol router.
func RegisterWebProtocol(scheme string, handler http.Handler) error {
	if scheme == "" {
		scheme = defaultWebScheme
	}
	if handler == nil {
		return errors.New("web protocol: nil handler")
	}
	return mygo.Protocol.Handle(scheme, handler)
}

// WorkbenchURL computes the initial URL loaded by the workbench system WebView.
func WorkbenchURL(cfg WebViewConfig) string {
	if strings.TrimSpace(cfg.ServerURL) != "" {
		return strings.TrimSpace(cfg.ServerURL)
	}
	scheme := cfg.Scheme
	if scheme == "" {
		scheme = defaultWebScheme
	}
	host := cfg.Host
	if host == "" {
		host = "localhost"
	}
	return fmt.Sprintf("%s://%s/", scheme, host)
}

// WorkbenchWindowOptions constructs MyGo WindowOptions for the shared Solid 2 workbench.
func WorkbenchWindowOptions(cfg WebViewConfig) mygo.WindowOptions {
	preload := cfg.PreloadJS
	if preload == "" {
		preload = ChordBridgePreloadScript()
	}
	return mygo.WindowOptions{
		Title:           "VibeValley",
		Width:           1280,
		Height:          820,
		MinWidth:        900,
		MinHeight:       600,
		TitleBarStyle:   mygo.TitleBarHiddenInset,
		BackgroundColor: "light-dark(#fcfcfb, #151413)",
		URL:             WorkbenchURL(cfg),
		Page: mygo.PageOptions{
			PreloadScript: preload,
		},
	}
}
