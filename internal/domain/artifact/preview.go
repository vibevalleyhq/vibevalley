package artifact

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// StrictPreviewCSP locks preview execution to an opaque sandboxed origin with no outbound network or workbench access.
const StrictPreviewCSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"

// StrictPrintPreviewCSP permits window.print() dialogs when ?print=1 is explicitly requested while retaining all origin/network locks.
const StrictPrintPreviewCSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"

// PreviewConfig configures an isolated-origin HTTP preview handler.
type PreviewConfig struct {
	Store               *DeliverableStore
	CAS                 *ContentStore
	PreviewHost         string
	WorkbenchHosts      []string
	AllowWorkbenchEmbed bool
}

// PreviewHandler serves compiled HTML artifacts by SHA-256 or (artifactID, version) with strict CSP and origin isolation.
type PreviewHandler struct {
	store               *DeliverableStore
	cas                 *ContentStore
	previewHost         string
	workbenchHosts      []string
	allowWorkbenchEmbed bool
}

// NewPreviewHandler creates an isolated-origin http.Handler serving compiled deliverables.
func NewPreviewHandler(cfg PreviewConfig) *PreviewHandler {
	cas := cfg.CAS
	if cas == nil && cfg.Store != nil {
		cas = cfg.Store.CAS()
	}
	wb := make([]string, 0, len(cfg.WorkbenchHosts))
	for _, h := range cfg.WorkbenchHosts {
		if norm := normalizeHostSpec(h); norm != "" {
			wb = append(wb, norm)
		}
	}
	return &PreviewHandler{
		store:               cfg.Store,
		cas:                 cas,
		previewHost:         normalizeHostSpec(cfg.PreviewHost),
		workbenchHosts:      wb,
		allowWorkbenchEmbed: cfg.AllowWorkbenchEmbed,
	}
}

// SHA256PreviewPath returns the canonical preview path for a content-addressed HTML bundle.
func SHA256PreviewPath(sha256Hex string) string {
	return "/preview/sha256/" + strings.ToLower(strings.TrimSpace(sha256Hex))
}

// ArtifactVersionPreviewPath returns the canonical preview path for a versioned deliverable.
func ArtifactVersionPreviewPath(artifactID string, version int) string {
	return fmt.Sprintf("/preview/artifact/%s/%d", url.PathEscape(artifactID), version)
}

func (h *PreviewHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	isPrint := r.URL.Query().Get("print") == "1"
	h.applyIsolationHeaders(w.Header(), isPrint)

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, ErrMethodNotAllowed.Error(), http.StatusMethodNotAllowed)
		return
	}

	if r.Header.Get("Authorization") != "" {
		http.Error(w, ErrOriginForbidden.Error(), http.StatusForbidden)
		return
	}

	if err := h.checkOriginIsolation(r); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	sha, payload, err := h.resolvePayload(r)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidSHA256), errors.Is(err, ErrInvalidDisplayMode):
			http.Error(w, err.Error(), http.StatusBadRequest)
		case errors.Is(err, ErrNotFound), errors.Is(err, ErrBlobNotFound), errors.Is(err, ErrVersionNotFound):
			http.Error(w, err.Error(), http.StatusNotFound)
		default:
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	etag := `"` + sha + `"`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", etag)

	if match := strings.TrimSpace(r.Header.Get("If-None-Match")); match == etag || match == sha {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(payload)
}

func (h *PreviewHandler) applyIsolationHeaders(hdr http.Header, printMode bool) {
	csp := StrictPreviewCSP
	if printMode {
		csp = StrictPrintPreviewCSP
	}
	hdr.Set("Content-Security-Policy", csp)
	hdr.Set("X-Content-Type-Options", "nosniff")
	hdr.Set("Referrer-Policy", "no-referrer")
	hdr.Set("Cross-Origin-Opener-Policy", "same-origin")
	if h.allowWorkbenchEmbed {
		hdr.Set("Cross-Origin-Resource-Policy", "cross-origin")
	} else {
		hdr.Set("Cross-Origin-Resource-Policy", "same-origin")
	}
	hdr.Set("Origin-Agent-Cluster", "?1")
	hdr.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
	hdr.Set("Vary", "Origin, Host")
	// Never expose CORS allow headers or credentials on preview responses.
	hdr.Del("Access-Control-Allow-Origin")
	hdr.Del("Access-Control-Allow-Credentials")
	hdr.Del("Set-Cookie")
}

func (h *PreviewHandler) checkOriginIsolation(r *http.Request) error {
	reqHost := normalizeHostSpec(r.Host)
	for _, wb := range h.workbenchHosts {
		if reqHost != "" && hostMatches(reqHost, wb) {
			return fmt.Errorf("%w: preview refused on workbench host %q", ErrOriginForbidden, r.Host)
		}
	}
	if h.previewHost != "" && (reqHost == "" || !hostMatches(reqHost, h.previewHost)) {
		return fmt.Errorf("%w: host %q does not match isolated preview host %q", ErrOriginForbidden, r.Host, h.previewHost)
	}
	return nil
}

func (h *PreviewHandler) resolvePayload(r *http.Request) (string, []byte, error) {
	cleanPath := r.URL.Path
	if strings.Contains(cleanPath, "..") {
		return "", nil, fmt.Errorf("%w: path traversal rejected", ErrNotFound)
	}

	var shaPrefix string
	switch {
	case strings.HasPrefix(cleanPath, "/preview/sha256/"):
		shaPrefix = strings.TrimPrefix(cleanPath, "/preview/sha256/")
	case strings.HasPrefix(cleanPath, "/sha256/"):
		shaPrefix = strings.TrimPrefix(cleanPath, "/sha256/")
	}
	if shaPrefix != "" || strings.HasPrefix(cleanPath, "/preview/sha256") {
		if shaPrefix == "" || strings.Contains(shaPrefix, "/") {
			return "", nil, fmt.Errorf("%w: invalid sha256 preview path", ErrInvalidSHA256)
		}
		if h.cas == nil {
			return "", nil, fmt.Errorf("%w: content store unavailable", ErrBlobNotFound)
		}
		norm, err := NormalizeSHA256(shaPrefix)
		if err != nil {
			return "", nil, err
		}
		data, err := h.cas.Get(norm)
		if err != nil {
			return "", nil, err
		}
		return norm, data, nil
	}

	var artRest string
	switch {
	case strings.HasPrefix(cleanPath, "/preview/artifact/"):
		artRest = strings.TrimPrefix(cleanPath, "/preview/artifact/")
	case strings.HasPrefix(cleanPath, "/api/v1/artifact/"):
		artRest = strings.TrimPrefix(cleanPath, "/api/v1/artifact/")
	case strings.HasPrefix(cleanPath, "/artifact/"):
		artRest = strings.TrimPrefix(cleanPath, "/artifact/")
	}
	if artRest != "" {
		if h.store == nil {
			return "", nil, fmt.Errorf("%w: deliverable store unavailable", ErrNotFound)
		}
		parts := strings.Split(artRest, "/")
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
			return "", nil, fmt.Errorf("%w: invalid artifact preview path", ErrNotFound)
		}
		ver, err := strconv.Atoi(parts[1])
		if err != nil || ver <= 0 {
			return "", nil, fmt.Errorf("%w: invalid version %q", ErrVersionNotFound, parts[1])
		}
		vMeta, data, err := h.store.GetVersion(r.Context(), parts[0], ver)
		if err != nil {
			return "", nil, err
		}
		return vMeta.HTMLSHA256, data, nil
	}

	return "", nil, fmt.Errorf("%w: unknown preview route %q", ErrNotFound, cleanPath)
}

func normalizeHostSpec(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if strings.Contains(s, "://") {
		if u, err := url.Parse(s); err == nil && u.Host != "" {
			s = u.Host
		}
	}
	return strings.ToLower(s)
}

func hostMatches(actual, pattern string) bool {
	if actual == pattern {
		return true
	}
	// If pattern omits port, match hostname regardless of port; if pattern has port, require exact host:port.
	if !strings.Contains(pattern, ":") {
		ah, _, err := net.SplitHostPort(actual)
		if err == nil && strings.ToLower(ah) == pattern {
			return true
		}
	}
	return false
}
