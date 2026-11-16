package vault

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// EgressProxy exposes OutboundTransport as a control-plane HTTP / Git / MCP egress http.Handler.
type EgressProxy struct {
	transport *OutboundTransport
}

// NewEgressProxy creates a control-plane egress proxy http.Handler backed by store and verifier.
func NewEgressProxy(store *Store, verifier TokenVerifier, opts ...OutboundOption) (*EgressProxy, error) {
	tr, err := NewOutboundTransport(store, verifier, opts...)
	if err != nil {
		return nil, err
	}
	return &EgressProxy{transport: tr}, nil
}

// OutboundTransport returns the underlying transport wrapper enforced by this proxy.
func (p *EgressProxy) OutboundTransport() *OutboundTransport {
	return p.transport
}

// ServeHTTP handles absolute-URL forward proxy requests and X-Vibe-Target-URL gateway requests.
func (p *EgressProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method := strings.ToUpper(r.Method)
	if method == http.MethodConnect || method == http.MethodTrace || method == "TRACK" {
		p.transport.emitAudit(r.Context(), AuditEvent{
			Timestamp:  p.transport.cfg.Clock().UTC(),
			Decision:   "deny",
			Reason:     "method_denied",
			Method:     method,
			TargetHost: r.URL.Hostname(),
			TargetPort: r.URL.Port(),
			TargetPath: r.URL.Path,
		})
		writeProxyError(w, http.StatusForbidden, "method_denied", fmt.Sprintf("HTTP method %s is not permitted", method))
		return
	}

	targetURL, err := resolveProxyTargetURL(r)
	if err != nil {
		p.transport.emitAudit(r.Context(), AuditEvent{
			Timestamp:  p.transport.cfg.Clock().UTC(),
			Decision:   "deny",
			Reason:     "invalid_target_url",
			Method:     method,
			TargetPath: r.URL.Path,
		})
		status, code := statusForError(err)
		writeProxyError(w, status, code, "invalid outbound target URL")
		return
	}

	forwardReq := r.Clone(r.Context())
	forwardReq.URL = targetURL
	forwardReq.Host = targetURL.Host
	forwardReq.RequestURI = ""

	resp, err := p.transport.RoundTrip(forwardReq)
	if err != nil {
		status, code := statusForError(err)
		writeProxyError(w, status, code, sanitizedErrorMessage(status, code))
		return
	}
	defer resp.Body.Close()

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)

	isStream := strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") || resp.ContentLength < 0
	if flusher, ok := w.(http.Flusher); ok && isStream {
		streamWithFlush(w, flusher, resp.Body)
		return
	}
	_, _ = io.Copy(w, resp.Body)
}

func resolveProxyTargetURL(r *http.Request) (*url.URL, error) {
	headerTarget := strings.TrimSpace(r.Header.Get(HeaderTargetURL))
	if headerTarget != "" {
		parsed, err := url.Parse(headerTarget)
		if err != nil || !parsed.IsAbs() {
			return nil, fmt.Errorf("%w: invalid %s header", ErrInvalidTargetURL, HeaderTargetURL)
		}
		if r.URL != nil && r.URL.IsAbs() && r.URL.String() != parsed.String() {
			return nil, fmt.Errorf("%w: conflicting target URL in request line and header", ErrInvalidTargetURL)
		}
		return parsed, nil
	}

	if r.URL != nil && r.URL.IsAbs() {
		if r.Host != "" && !strings.EqualFold(r.Host, r.URL.Host) {
			return nil, fmt.Errorf("%w: Host header does not match target URL", ErrInvalidTargetURL)
		}
		return cloneURL(r.URL), nil
	}

	return nil, fmt.Errorf("%w: absolute URL or %s header is required", ErrInvalidTargetURL, HeaderTargetURL)
}

func copyResponseHeaders(dst, src http.Header) {
	skip := make(map[string]struct{}, len(hopByHopHeaders))
	for _, h := range hopByHopHeaders {
		skip[http.CanonicalHeaderKey(h)] = struct{}{}
	}
	for _, connVal := range src.Values("Connection") {
		for field := range strings.SplitSeq(connVal, ",") {
			if name := strings.TrimSpace(field); name != "" {
				skip[http.CanonicalHeaderKey(name)] = struct{}{}
			}
		}
	}
	for k, vals := range src {
		if _, blocked := skip[http.CanonicalHeaderKey(k)]; blocked {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
}

func streamWithFlush(w io.Writer, flusher http.Flusher, body io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, wErr := w.Write(buf[:n]); wErr != nil {
				return
			}
			flusher.Flush()
		}
		if err != nil {
			return
		}
	}
}

func writeProxyError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}{
		Code:  code,
		Error: msg,
	})
}

func sanitizedErrorMessage(status int, code string) string {
	switch status {
	case http.StatusUnauthorized:
		return "capability token missing, invalid, or expired"
	case http.StatusForbidden:
		return fmt.Sprintf("egress request denied (%s)", code)
	case http.StatusConflict:
		return "multiple vault credentials match target; specify credential ID"
	case http.StatusBadRequest:
		return "invalid outbound target request"
	default:
		return "upstream egress request failed"
	}
}
