package machine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	ErrTargetNotAllowed = errors.New("machine: mcp tunnel target not allowed")
	ErrPrincipalDenied  = errors.New("machine: tunnel principal denied")
	ErrResponseTooLarge = errors.New("machine: tunnel response exceeds size limit")
	ErrUnsupportedFrame = errors.New("machine: unsupported link frame kind")
)

const (
	defaultTunnelTimeout  = 30 * time.Second
	defaultTunnelMaxBytes = 16 << 20 // 16 MiB
)

// MCPTarget registers a private intranet MCP server reachable from this machine.
type MCPTarget struct {
	ID          string            `json:"id"`
	Endpoint    string            `json:"endpoint"`
	AllowedPath string            `json:"allowedPath,omitempty"`
	Headers     map[string]string `json:"-"`
	Timeout     time.Duration     `json:"-"`
}

// TunnelHTTPRequest describes a proxied HTTP/MCP invocation forwarded over the outbound link.
type TunnelHTTPRequest struct {
	RequestID string              `json:"requestId"`
	TargetID  string              `json:"targetId"`
	Method    string              `json:"method"`
	Path      string              `json:"path,omitempty"`
	Headers   map[string]string   `json:"headers,omitempty"`
	Body      []byte              `json:"body,omitempty"`
	Principal *contract.Principal `json:"principal,omitempty"`
}

// TunnelHTTPResponse carries the intranet MCP server's HTTP response back to the control plane.
type TunnelHTTPResponse struct {
	RequestID  string            `json:"requestId"`
	StatusCode int               `json:"statusCode"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       []byte            `json:"body,omitempty"`
	Error      string            `json:"error,omitempty"`
}

type registeredTarget struct {
	spec    MCPTarget
	baseURL *url.URL
}

// TunnelHandler proxies authenticated reverse-tunnel requests to registered intranet MCP servers.
type TunnelHandler struct {
	mu       sync.RWMutex
	targets  map[string]registeredTarget
	client   *http.Client
	maxBytes int64
	now      func() time.Time
}

// TunnelHandlerConfig configures the intranet MCP reverse-tunnel proxy.
type TunnelHandlerConfig struct {
	Targets          []MCPTarget
	HTTPClient       *http.Client
	MaxResponseBytes int64
	Now              func() time.Time
}

// NewTunnelHandler validates targets and creates a reverse-tunnel MCP handler.
func NewTunnelHandler(cfg TunnelHandlerConfig) (*TunnelHandler, error) {
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: defaultTunnelTimeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	maxBytes := cfg.MaxResponseBytes
	if maxBytes <= 0 {
		maxBytes = defaultTunnelMaxBytes
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}

	h := &TunnelHandler{
		targets:  make(map[string]registeredTarget, len(cfg.Targets)),
		client:   client,
		maxBytes: maxBytes,
		now:      now,
	}
	for _, t := range cfg.Targets {
		if err := h.RegisterTarget(t); err != nil {
			return nil, err
		}
	}
	return h, nil
}

// RegisterTarget adds or replaces a registered private MCP server target.
func (h *TunnelHandler) RegisterTarget(spec MCPTarget) error {
	id := strings.TrimSpace(spec.ID)
	if id == "" {
		return errors.New("machine: mcp target id must not be empty")
	}
	parsed, err := url.Parse(strings.TrimSpace(spec.Endpoint))
	if err != nil {
		return fmt.Errorf("machine: parse target %q endpoint: %w", id, err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("machine: target %q endpoint must be http(s) URL with host", id)
	}
	if spec.Timeout <= 0 {
		spec.Timeout = defaultTunnelTimeout
	}
	spec.ID = id

	h.mu.Lock()
	h.targets[id] = registeredTarget{spec: spec, baseURL: parsed}
	h.mu.Unlock()
	return nil
}

// Targets returns the public metadata of all registered MCP targets without local headers.
func (h *TunnelHandler) Targets() []MCPTarget {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]MCPTarget, 0, len(h.targets))
	for _, entry := range h.targets {
		out = append(out, MCPTarget{
			ID:          entry.spec.ID,
			Endpoint:    entry.spec.Endpoint,
			AllowedPath: entry.spec.AllowedPath,
		})
	}
	return out
}

// HandleMCPRequest validates authorization and forwards an HTTP/MCP request to the local/intranet target.
func (h *TunnelHandler) HandleMCPRequest(ctx context.Context, req TunnelHTTPRequest) TunnelHTTPResponse {
	resp := TunnelHTTPResponse{RequestID: req.RequestID}

	h.mu.RLock()
	target, ok := h.targets[req.TargetID]
	h.mu.RUnlock()
	if !ok {
		resp.StatusCode = http.StatusForbidden
		resp.Error = fmt.Sprintf("%s: %s", ErrTargetNotAllowed, req.TargetID)
		return resp
	}

	if err := h.validatePrincipal(req.Principal, target.baseURL); err != nil {
		if errors.Is(err, ErrPrincipalDenied) {
			resp.StatusCode = http.StatusUnauthorized
		} else {
			resp.StatusCode = http.StatusForbidden
		}
		resp.Error = err.Error()
		return resp
	}

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodPost
	}
	if !isValidHTTPMethod(method) {
		resp.StatusCode = http.StatusBadRequest
		resp.Error = fmt.Sprintf("invalid http method %q", req.Method)
		return resp
	}

	targetURL, err := resolveTargetURL(target.baseURL, target.spec.AllowedPath, req.Path)
	if err != nil {
		resp.StatusCode = http.StatusForbidden
		resp.Error = err.Error()
		return resp
	}

	callCtx, cancel := context.WithTimeout(ctx, target.spec.Timeout)
	defer cancel()

	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = bytes.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(callCtx, method, targetURL.String(), bodyReader)
	if err != nil {
		resp.StatusCode = http.StatusBadRequest
		resp.Error = err.Error()
		return resp
	}

	for k, v := range req.Headers {
		if isHopByHopHeader(k) || strings.EqualFold(k, "Host") {
			continue
		}
		httpReq.Header.Set(k, v)
	}
	for k, v := range target.spec.Headers {
		httpReq.Header.Set(k, v)
	}

	httpResp, err := h.client.Do(httpReq)
	if err != nil {
		resp.StatusCode = http.StatusBadGateway
		resp.Error = err.Error()
		return resp
	}
	defer httpResp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(httpResp.Body, h.maxBytes+1))
	if err != nil {
		resp.StatusCode = http.StatusBadGateway
		resp.Error = err.Error()
		return resp
	}
	if int64(len(bodyBytes)) > h.maxBytes {
		resp.StatusCode = http.StatusBadGateway
		resp.Error = ErrResponseTooLarge.Error()
		return resp
	}

	outHeaders := make(map[string]string)
	for k, vals := range httpResp.Header {
		if isHopByHopHeader(k) || len(vals) == 0 {
			continue
		}
		outHeaders[k] = strings.Join(vals, ", ")
	}

	resp.StatusCode = httpResp.StatusCode
	resp.Headers = outHeaders
	resp.Body = bodyBytes
	return resp
}

func (h *TunnelHandler) validatePrincipal(p *contract.Principal, targetURL *url.URL) error {
	if p == nil {
		return nil
	}
	if p.ExpiresAtMs > 0 && h.now().UnixMilli() > p.ExpiresAtMs {
		return fmt.Errorf("%w: token expired", ErrPrincipalDenied)
	}
	if len(p.AllowedHosts) > 0 {
		hostOnly := strings.ToLower(targetURL.Hostname())
		hostPort := strings.ToLower(targetURL.Host)
		allowed := false
		for _, entry := range p.AllowedHosts {
			candidate := strings.ToLower(strings.TrimSpace(entry))
			if candidate == "" {
				continue
			}
			if candidate == hostOnly || candidate == hostPort {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("%w: host %q not in allowedHosts", ErrTargetNotAllowed, targetURL.Host)
		}
	}
	return nil
}

func resolveTargetURL(base *url.URL, allowedPrefix, reqPath string) (*url.URL, error) {
	out := *base
	if reqPath == "" {
		return &out, nil
	}
	if strings.Contains(reqPath, "://") || strings.HasPrefix(reqPath, "//") {
		return nil, fmt.Errorf("%w: absolute path override rejected", ErrTargetNotAllowed)
	}
	parsedReq, err := url.Parse(reqPath)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid path %q", ErrTargetNotAllowed, reqPath)
	}
	if parsedReq.Scheme != "" || parsedReq.Host != "" {
		return nil, fmt.Errorf("%w: host override rejected", ErrTargetNotAllowed)
	}

	rawPath := parsedReq.Path
	for seg := range strings.SplitSeq(rawPath, "/") {
		if seg == ".." {
			return nil, fmt.Errorf("%w: parent traversal in path %q", ErrTargetNotAllowed, reqPath)
		}
	}

	basePath := base.Path
	if basePath == "" {
		basePath = "/"
	}
	joined := path.Join(basePath, strings.TrimPrefix(rawPath, "/"))
	if !strings.HasPrefix(joined, "/") {
		joined = "/" + joined
	}
	if allowedPrefix != "" {
		cleanPrefix := path.Clean("/" + strings.TrimPrefix(allowedPrefix, "/"))
		if joined != cleanPrefix && !strings.HasPrefix(joined, strings.TrimSuffix(cleanPrefix, "/")+"/") {
			return nil, fmt.Errorf("%w: path %q outside allowedPrefix %q", ErrTargetNotAllowed, joined, cleanPrefix)
		}
	}

	out.Path = joined
	if parsedReq.RawQuery != "" {
		if out.RawQuery != "" {
			out.RawQuery = out.RawQuery + "&" + parsedReq.RawQuery
		} else {
			out.RawQuery = parsedReq.RawQuery
		}
	}
	return &out, nil
}

func isHopByHopHeader(k string) bool {
	switch strings.ToLower(k) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func isValidHTTPMethod(m string) bool {
	for i := 0; i < len(m); i++ {
		c := m[i]
		if c < 'A' || c > 'Z' {
			return false
		}
	}
	return len(m) > 0
}

// LinkFrame is a generic multiplexed message envelope compatible with Chord link transport.
type LinkFrame struct {
	ID      string          `json:"id,omitempty"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// LinkTransport abstracts bidirectional frame I/O over an outbound WebSocket, Chord Link, or pipe.
type LinkTransport interface {
	ReadFrame(ctx context.Context) (LinkFrame, error)
	WriteFrame(ctx context.Context, frame LinkFrame) error
	Close() error
}

// ConnLinkTransport implements LinkTransport using newline-delimited JSON frames over a net.Conn.
type ConnLinkTransport struct {
	conn    net.Conn
	reader  *bufio.Reader
	readMu  sync.Mutex
	writeMu sync.Mutex
}

// NewConnLinkTransport wraps conn as a thread-safe LinkTransport.
func NewConnLinkTransport(conn net.Conn) *ConnLinkTransport {
	return &ConnLinkTransport{
		conn:   conn,
		reader: bufio.NewReader(conn),
	}
}

// PipeLinkPair returns two connected LinkTransport endpoints backed by net.Pipe for local or test IPC.
func PipeLinkPair() (client LinkTransport, server LinkTransport) {
	c1, c2 := net.Pipe()
	return NewConnLinkTransport(c1), NewConnLinkTransport(c2)
}

func (t *ConnLinkTransport) ReadFrame(ctx context.Context) (LinkFrame, error) {
	if err := ctx.Err(); err != nil {
		return LinkFrame{}, err
	}
	t.readMu.Lock()
	defer t.readMu.Unlock()

	stop := context.AfterFunc(ctx, func() {
		_ = t.conn.SetReadDeadline(time.Now())
	})
	defer stop()

	line, err := t.reader.ReadBytes('\n')
	if ctx.Err() != nil {
		return LinkFrame{}, ctx.Err()
	}
	if err != nil {
		return LinkFrame{}, err
	}
	var frame LinkFrame
	if err := json.Unmarshal(bytes.TrimSpace(line), &frame); err != nil {
		return LinkFrame{}, err
	}
	return frame, nil
}

func (t *ConnLinkTransport) WriteFrame(ctx context.Context, frame LinkFrame) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	raw, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	t.writeMu.Lock()
	defer t.writeMu.Unlock()

	stop := context.AfterFunc(ctx, func() {
		_ = t.conn.SetWriteDeadline(time.Now())
	})
	defer stop()

	return writeAll(t.conn, raw)
}

func (t *ConnLinkTransport) Close() error {
	return t.conn.Close()
}

type envLeasePayload struct {
	SessionID string        `json:"sessionId"`
	LeaseID   string        `json:"leaseId,omitempty"`
	Req       *LeaseRequest `json:"req,omitempty"`
}

type envWritePayload struct {
	LeaseID string `json:"leaseId"`
	RelPath string `json:"relPath"`
	Data    []byte `json:"data"`
	Perm    uint32 `json:"perm,omitempty"`
}

type envEditPayload struct {
	LeaseID string `json:"leaseId"`
	RelPath string `json:"relPath"`
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

type envReadPayload struct {
	LeaseID string `json:"leaseId"`
	RelPath string `json:"relPath"`
}

type envExecPayload struct {
	LeaseID string            `json:"leaseId"`
	Spec    contract.ExecSpec `json:"spec"`
}

type envSyncPayload struct {
	LeaseID string                    `json:"leaseId"`
	Req     contract.MountSyncRequest `json:"req"`
}

type rpcErrorPayload struct {
	Error string `json:"error"`
}

// ServeLink runs the reverse RPC & MCP tunnel dispatch loop over transport until ctx cancels
// or transport disconnects. On disconnect, all active Exec process trees are terminated cleanly.
func (n *Node) ServeLink(ctx context.Context, transport LinkTransport) error {
	if transport == nil {
		return errors.New("machine: nil link transport")
	}

	linkCtx, cancelLink := context.WithCancelCause(ctx)
	defer cancelLink(ErrLinkDisconnected)

	var wg sync.WaitGroup
	var writeMu sync.Mutex

	sendFrame := func(frame LinkFrame) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = transport.WriteFrame(linkCtx, frame)
	}

	stopClose := context.AfterFunc(ctx, func() {
		_ = transport.Close()
	})
	defer stopClose()

	var readErr error
	for {
		frame, err := transport.ReadFrame(linkCtx)
		if err != nil {
			readErr = err
			break
		}
		wg.Add(1)
		go func(f LinkFrame) {
			defer wg.Done()
			reply := n.dispatchLinkFrame(linkCtx, f)
			if reply.Kind != "" {
				sendFrame(reply)
			}
		}(frame)
	}

	cancelLink(ErrLinkDisconnected)
	n.leases.DisconnectAll(ErrLinkDisconnected)
	_ = transport.Close()
	wg.Wait()

	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(readErr, io.EOF) {
		return ErrLinkDisconnected
	}
	return readErr
}

func (n *Node) dispatchLinkFrame(ctx context.Context, frame LinkFrame) LinkFrame {
	switch frame.Kind {
	case "ping":
		return LinkFrame{ID: frame.ID, Kind: "pong"}

	case "mcp_http_req":
		var req TunnelHTTPRequest
		if err := json.Unmarshal(frame.Payload, &req); err != nil {
			return errFrame(frame.ID, "mcp_http_res", err)
		}
		if req.RequestID == "" {
			req.RequestID = frame.ID
		}
		res := n.tunnel.HandleMCPRequest(ctx, req)
		return okFrame(frame.ID, "mcp_http_res", res)

	case "env_lease_acquire_req":
		var req LeaseRequest
		if err := json.Unmarshal(frame.Payload, &req); err != nil {
			return errFrame(frame.ID, "env_lease_acquire_res", err)
		}
		lease, _, err := n.leases.Acquire(ctx, req)
		if err != nil {
			return errFrame(frame.ID, "env_lease_acquire_res", err)
		}
		return okFrame(frame.ID, "env_lease_acquire_res", lease)

	case "env_lease_release_req":
		var p envLeasePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			return errFrame(frame.ID, "env_lease_release_res", err)
		}
		if err := n.leases.Release(ctx, Lease{ID: p.LeaseID}); err != nil {
			return errFrame(frame.ID, "env_lease_release_res", err)
		}
		return okFrame(frame.ID, "env_lease_release_res", map[string]bool{"released": true})

	case "env_write_req":
		var p envWritePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			return errFrame(frame.ID, "env_write_res", err)
		}
		_, env, ok := n.leases.Get(p.LeaseID)
		if !ok {
			return errFrame(frame.ID, "env_write_res", ErrLeaseNotFound)
		}
		if err := env.WriteAtomic(ctx, p.RelPath, p.Data, p.Perm); err != nil {
			return errFrame(frame.ID, "env_write_res", err)
		}
		return okFrame(frame.ID, "env_write_res", map[string]bool{"ok": true})

	case "env_edit_req":
		var p envEditPayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			return errFrame(frame.ID, "env_edit_res", err)
		}
		_, env, ok := n.leases.Get(p.LeaseID)
		if !ok {
			return errFrame(frame.ID, "env_edit_res", ErrLeaseNotFound)
		}
		if err := env.EditPatch(ctx, p.RelPath, p.OldText, p.NewText); err != nil {
			return errFrame(frame.ID, "env_edit_res", err)
		}
		return okFrame(frame.ID, "env_edit_res", map[string]bool{"ok": true})

	case "env_read_req":
		var p envReadPayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			return errFrame(frame.ID, "env_read_res", err)
		}
		_, env, ok := n.leases.Get(p.LeaseID)
		if !ok {
			return errFrame(frame.ID, "env_read_res", ErrLeaseNotFound)
		}
		data, err := env.ReadFile(ctx, p.RelPath)
		if err != nil {
			return errFrame(frame.ID, "env_read_res", err)
		}
		return okFrame(frame.ID, "env_read_res", map[string][]byte{"data": data})

	case "env_exec_req":
		var p envExecPayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			return errFrame(frame.ID, "env_exec_res", err)
		}
		_, env, ok := n.leases.Get(p.LeaseID)
		if !ok {
			return errFrame(frame.ID, "env_exec_res", ErrLeaseNotFound)
		}
		res, err := env.Exec(ctx, p.Spec)
		if err != nil {
			return okFrame(frame.ID, "env_exec_res", struct {
				contract.ExecResult
				Error string `json:"error"`
			}{ExecResult: res, Error: err.Error()})
		}
		return okFrame(frame.ID, "env_exec_res", res)

	case "env_sync_req":
		var p envSyncPayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			return errFrame(frame.ID, "env_sync_res", err)
		}
		_, env, ok := n.leases.Get(p.LeaseID)
		if !ok {
			return errFrame(frame.ID, "env_sync_res", ErrLeaseNotFound)
		}
		res, err := env.SyncMounts(ctx, p.Req)
		if err != nil {
			return errFrame(frame.ID, "env_sync_res", err)
		}
		return okFrame(frame.ID, "env_sync_res", res)

	case "env_harvest_req":
		var p envLeasePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			return errFrame(frame.ID, "env_harvest_res", err)
		}
		_, env, ok := n.leases.Get(p.LeaseID)
		if !ok {
			return errFrame(frame.ID, "env_harvest_res", ErrLeaseNotFound)
		}
		outs, err := env.HarvestOutputs(ctx)
		if err != nil {
			return errFrame(frame.ID, "env_harvest_res", err)
		}
		return okFrame(frame.ID, "env_harvest_res", outs)

	default:
		return errFrame(frame.ID, "error", fmt.Errorf("%w: %s", ErrUnsupportedFrame, frame.Kind))
	}
}

func okFrame(id, kind string, payload any) LinkFrame {
	raw, err := json.Marshal(payload)
	if err != nil {
		return errFrame(id, kind, err)
	}
	return LinkFrame{ID: id, Kind: kind, Payload: raw}
}

func errFrame(id, kind string, err error) LinkFrame {
	raw, _ := json.Marshal(rpcErrorPayload{Error: err.Error()})
	return LinkFrame{ID: id, Kind: kind, Payload: raw}
}
