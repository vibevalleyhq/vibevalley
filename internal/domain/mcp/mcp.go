package mcp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	// ProtocolVersion is the MCP Streamable HTTP protocol version supported by this handler.
	ProtocolVersion = "2025-03-26"
	// SessionHeader is the HTTP header carrying the MCP Streamable HTTP session ID.
	SessionHeader = "Mcp-Session-Id"

	maxRequestBytes = 4 << 20
	maxErrorTextLen = 8000
)

var (
	// ErrToolNotFound may be returned by ToolCatalog.CallTool when a requested tool does not exist.
	ErrToolNotFound = errors.New("mcp: tool not found")
	// ErrUnauthorizedCaller may be returned when bearer token verification fails.
	ErrUnauthorizedCaller = errors.New("mcp: unknown caller")
)

// ToolSpec describes one MCP tool exposed in tools/list.
type ToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// ContentBlock represents one content item in an MCP tools/call response.
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// ToolResult represents the result payload of an MCP tools/call invocation.
type ToolResult struct {
	Content []ContentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

// CallerContext describes the authenticated caller on an MCP request.
type CallerContext struct {
	Token      string
	SessionID  string
	MCPSession string
	Headers    http.Header
}

// ToolCatalog is the clean boundary implemented by Wave 2 DomainToolRegistry.
type ToolCatalog interface {
	ListTools(ctx context.Context, caller CallerContext) ([]ToolSpec, error)
	CallTool(ctx context.Context, caller CallerContext, name string, args json.RawMessage) (ToolResult, error)
}

// TokenAuthenticator resolves an optional Bearer token to an internal session ID.
type TokenAuthenticator func(ctx context.Context, token string) (sessionID string, ok bool)

// Config configures the loopback-only MCP Streamable HTTP handler.
type Config struct {
	ServerName        string
	ServerVersion     string
	Catalog           ToolCatalog
	Authenticate      TokenAuthenticator
	RequireBearerAuth bool
	SSEKeepAlive      time.Duration
}

// Handler implements MCP Streamable HTTP JSON-RPC 2.0 (POST/GET/DELETE /mcp) on loopback only.
type Handler struct {
	serverName    string
	serverVersion string
	catalog       ToolCatalog
	authenticate  TokenAuthenticator
	requireAuth   bool
	keepAlive     time.Duration

	closeOnce sync.Once
	closeCh   chan struct{}

	mu       sync.RWMutex
	sessions map[string]mcpSession
}

type mcpSession struct {
	id        string
	createdAt time.Time
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// NewHandler creates a loopback-only MCP Streamable HTTP handler.
func NewHandler(cfg Config) *Handler {
	name := strings.TrimSpace(cfg.ServerName)
	if name == "" {
		name = "vibevalley"
	}
	ver := strings.TrimSpace(cfg.ServerVersion)
	if ver == "" {
		ver = "0.1.0"
	}
	keepAlive := cfg.SSEKeepAlive
	if keepAlive <= 0 {
		keepAlive = 25 * time.Second
	}
	return &Handler{
		serverName:    name,
		serverVersion: ver,
		catalog:       cfg.Catalog,
		authenticate:  cfg.Authenticate,
		requireAuth:   cfg.RequireBearerAuth,
		keepAlive:     keepAlive,
		closeCh:       make(chan struct{}),
		sessions:      make(map[string]mcpSession),
	}
}

// Close terminates active SSE streams and marks the handler closed.
func (h *Handler) Close() error {
	h.closeOnce.Do(func() {
		close(h.closeCh)
	})
	return nil
}

// ServeHTTP dispatches POST/GET/DELETE /mcp exclusively for loopback callers.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !IsLoopbackRequest(r) {
		writeJSONRPCErrorHTTP(w, http.StatusForbidden, nil, -32003, "mcp endpoint accepts loopback connections only")
		return
	}
	if !allowedLoopbackOrigin(r.Header.Get("Origin")) {
		writeJSONRPCErrorHTTP(w, http.StatusForbidden, nil, -32003, "cross-origin request rejected")
		return
	}

	caller, ok := h.resolveCaller(r)
	if h.requireAuth && !ok {
		writeJSONRPCErrorHTTP(w, http.StatusUnauthorized, nil, -32001, "unauthorized mcp caller")
		return
	}

	switch r.Method {
	case http.MethodPost:
		h.handlePost(w, r, caller)
	case http.MethodGet:
		h.handleGet(w, r)
	case http.MethodDelete:
		h.handleDelete(w, r)
	default:
		w.Header().Set("Allow", "POST, GET, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Handler) resolveCaller(r *http.Request) (CallerContext, bool) {
	auth := r.Header.Get("Authorization")
	token := ""
	if strings.HasPrefix(auth, "Bearer ") {
		token = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	}
	caller := CallerContext{
		Token:      token,
		MCPSession: strings.TrimSpace(r.Header.Get(SessionHeader)),
		Headers:    r.Header.Clone(),
	}
	if h.authenticate == nil {
		return caller, true
	}
	if token == "" {
		return caller, false
	}
	sessID, ok := h.authenticate(r.Context(), token)
	if !ok {
		return caller, false
	}
	caller.SessionID = sessID
	return caller, true
}

func (h *Handler) handlePost(w http.ResponseWriter, r *http.Request, caller CallerContext) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if err != nil {
		writeJSONRPCErrorHTTP(w, http.StatusBadRequest, nil, -32700, "failed to read request body")
		return
	}
	if len(body) > maxRequestBytes {
		writeJSONRPCErrorHTTP(w, http.StatusRequestEntityTooLarge, nil, -32600, "request payload too large")
		return
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		writeJSONRPCErrorHTTP(w, http.StatusBadRequest, nil, -32700, "empty JSON-RPC payload")
		return
	}

	if trimmed[0] == '[' {
		var batch []json.RawMessage
		if err := json.Unmarshal(trimmed, &batch); err != nil || len(batch) == 0 {
			writeJSONRPCErrorHTTP(w, http.StatusBadRequest, nil, -32700, "invalid JSON-RPC batch")
			return
		}
		responses := make([]rpcResponse, 0, len(batch))
		var issuedSession string
		for _, item := range batch {
			resp, hasResp, sessID := h.dispatchRaw(r.Context(), item, caller)
			if sessID != "" {
				issuedSession = sessID
			}
			if hasResp {
				responses = append(responses, resp)
			}
		}
		if issuedSession != "" {
			w.Header().Set(SessionHeader, issuedSession)
		}
		if len(responses) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(responses)
		return
	}

	resp, hasResp, issuedSession := h.dispatchRaw(r.Context(), trimmed, caller)
	if issuedSession != "" {
		w.Header().Set(SessionHeader, issuedSession)
	}
	if !hasResp {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

func (h *Handler) handleGet(w http.ResponseWriter, r *http.Request) {
	accept := r.Header.Get("Accept")
	if !strings.Contains(accept, "text/event-stream") {
		http.Error(w, "Accept: text/event-stream required", http.StatusNotAcceptable)
		return
	}
	if sessID := strings.TrimSpace(r.Header.Get(SessionHeader)); sessID != "" && !h.hasSession(sessID) {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	flusher, canFlush := w.(http.Flusher)
	_, _ = io.WriteString(w, ": connected\n\n")
	if canFlush {
		flusher.Flush()
	}

	ticker := time.NewTicker(h.keepAlive)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-h.closeCh:
			return
		case <-ticker.C:
			_, err := io.WriteString(w, ": keepalive\n\n")
			if err != nil {
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
	}
}

func (h *Handler) handleDelete(w http.ResponseWriter, r *http.Request) {
	sessID := strings.TrimSpace(r.Header.Get(SessionHeader))
	if sessID == "" {
		http.Error(w, "missing Mcp-Session-Id header", http.StatusBadRequest)
		return
	}
	h.mu.Lock()
	_, exists := h.sessions[sessID]
	if exists {
		delete(h.sessions, sessID)
	}
	h.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) dispatchRaw(ctx context.Context, raw json.RawMessage, caller CallerContext) (rpcResponse, bool, string) {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      json.RawMessage("null"),
			Error:   &rpcError{Code: -32700, Message: "parse error"},
		}, true, ""
	}
	if req.JSONRPC != "2.0" || strings.TrimSpace(req.Method) == "" {
		id := req.ID
		if len(id) == 0 {
			id = json.RawMessage("null")
		}
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      id,
			Error:   &rpcError{Code: -32600, Message: "invalid JSON-RPC 2.0 request"},
		}, true, ""
	}

	isNotification := len(bytes.TrimSpace(req.ID)) == 0
	if isNotification {
		// Accept notifications such as notifications/initialized without emitting a response body.
		return rpcResponse{}, false, ""
	}

	switch req.Method {
	case "initialize":
		sessID := h.createSession()
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": ProtocolVersion,
				"capabilities": map[string]any{
					"tools": map[string]any{
						"listChanged": false,
					},
				},
				"serverInfo": map[string]any{
					"name":    h.serverName,
					"version": h.serverVersion,
				},
			},
		}, true, sessID

	case "ping":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]any{},
		}, true, ""

	case "tools/list":
		tools, err := h.listTools(ctx, caller)
		if err != nil {
			return rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32603, Message: redactToken(err.Error(), caller.Token)},
			}, true, ""
		}
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"tools": tools,
			},
		}, true, ""

	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &params); err != nil {
				return rpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Error:   &rpcError{Code: -32602, Message: "invalid tools/call params"},
				}, true, ""
			}
		}
		if strings.TrimSpace(params.Name) == "" {
			return rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "tool name is required"},
			}, true, ""
		}
		if len(bytes.TrimSpace(params.Arguments)) == 0 {
			params.Arguments = json.RawMessage("{}")
		}
		res := h.callTool(ctx, caller, params.Name, params.Arguments)
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  res,
		}, true, ""

	default:
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: fmt.Sprintf("method not found: %s", req.Method)},
		}, true, ""
	}
}

func (h *Handler) listTools(ctx context.Context, caller CallerContext) ([]ToolSpec, error) {
	if h.catalog == nil {
		return []ToolSpec{}, nil
	}
	specs, err := h.catalog.ListTools(ctx, caller)
	if err != nil {
		return nil, err
	}
	out := make([]ToolSpec, 0, len(specs))
	for _, spec := range specs {
		if len(bytes.TrimSpace(spec.InputSchema)) == 0 {
			spec.InputSchema = json.RawMessage(`{"type":"object"}`)
		}
		out = append(out, spec)
	}
	return out, nil
}

func (h *Handler) callTool(ctx context.Context, caller CallerContext, name string, args json.RawMessage) ToolResult {
	if h.authenticate != nil && caller.SessionID == "" {
		return errorToolResult("unknown caller")
	}
	if h.catalog == nil {
		return errorToolResult(fmt.Sprintf("unknown tool: %s", name))
	}
	res, err := h.catalog.CallTool(ctx, caller, name, args)
	if err != nil {
		msg := redactToken(err.Error(), caller.Token)
		if len(msg) > maxErrorTextLen {
			msg = msg[:maxErrorTextLen]
		}
		return errorToolResult(msg)
	}
	if res.IsError && caller.Token != "" {
		for i := range res.Content {
			res.Content[i].Text = redactToken(res.Content[i].Text, caller.Token)
		}
	}
	if res.Content == nil {
		res.Content = []ContentBlock{}
	}
	return res
}

func errorToolResult(msg string) ToolResult {
	return ToolResult{
		IsError: true,
		Content: []ContentBlock{{Type: "text", Text: msg}},
	}
}

func redactToken(text, token string) string {
	if token == "" {
		return text
	}
	return strings.ReplaceAll(text, token, "[redacted]")
}

func (h *Handler) createSession() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	id := hex.EncodeToString(buf[:])
	h.mu.Lock()
	h.sessions[id] = mcpSession{id: id, createdAt: time.Now()}
	h.mu.Unlock()
	return id
}

func (h *Handler) hasSession(id string) bool {
	h.mu.RLock()
	_, ok := h.sessions[id]
	h.mu.RUnlock()
	return ok
}

// IsLoopbackRequest returns true iff the immediate TCP peer is a loopback IP and no outside proxy marker is set.
func IsLoopbackRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.Header.Get("X-Vibevalley-Outside") != "" {
		return false
	}
	raw := strings.TrimSpace(r.RemoteAddr)
	if raw == "" {
		return false
	}
	host := raw
	if h, _, err := net.SplitHostPort(raw); err == nil {
		host = h
	}
	if zoneIdx := strings.IndexByte(host, '%'); zoneIdx >= 0 {
		host = host[:zoneIdx]
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return addr.Unmap().IsLoopback()
}

func allowedLoopbackOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	h := u.Hostname()
	if h == "localhost" {
		return true
	}
	addr, err := netip.ParseAddr(h)
	return err == nil && addr.Unmap().IsLoopback()
}

func writeJSONRPCErrorHTTP(w http.ResponseWriter, status int, id json.RawMessage, code int, msg string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: msg},
	})
}
