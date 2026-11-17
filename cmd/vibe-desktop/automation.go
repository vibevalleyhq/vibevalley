package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	_ "github.com/egoist/mygo/plugins/automation"
	"github.com/egoist/mygo/ui"
)

// AutomationNode mirrors an element from MyGo UI's accessibility tree for E2E inspection.
type AutomationNode struct {
	Index       int     `json:"index"`
	Role        string  `json:"role"`
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Value       string  `json:"value,omitempty"`
	Bounds      ui.Rect `json:"bounds"`
	Disabled    bool    `json:"disabled,omitempty"`
	Focusable   bool    `json:"focusable,omitempty"`
	Focused     bool    `json:"focused,omitempty"`
}

// InspectSnapshot captures the rendered Notch Island UI tree, terminal sessions, and WebView URL.
type InspectSnapshot struct {
	WebURL       string           `json:"webUrl"`
	StateVersion uint64           `json:"stateVersion"`
	RenderCount  uint64           `json:"renderCount"`
	FramePending bool             `json:"framePending"`
	Island       IslandState      `json:"island"`
	Texts        []string         `json:"texts"`
	Nodes        []AutomationNode `json:"nodes"`
	Terminals    []TerminalInfo   `json:"terminals,omitempty"`
}

// ClickResult reports the outcome and measured dispatch latency of an automated UI click.
type ClickResult struct {
	Target     string          `json:"target"`
	Matched    string          `json:"matched"`
	DurationMs float64         `json:"durationMs"`
	Snapshot   InspectSnapshot `json:"snapshot"`
}

// AutomationEndpoint drives and inspects the desktop Notch Island UI and subsystems for E2E verification.
type AutomationEndpoint struct {
	island    *IslandController
	terminals *TerminalController
	webCfg    WebViewConfig

	mu          sync.Mutex
	tester      *ui.Tester
	lastVersion uint64
}

// NewAutomationEndpoint constructs an AutomationEndpoint wired to island, terminals, and webCfg.
func NewAutomationEndpoint(island *IslandController, terminals *TerminalController, webCfg WebViewConfig) *AutomationEndpoint {
	return &AutomationEndpoint{
		island:    island,
		terminals: terminals,
		webCfg:    webCfg,
	}
}

func (a *AutomationEndpoint) ensureTesterLocked() *ui.Tester {
	if a.tester == nil {
		a.tester = ui.NewTester(a.island.View, 440, 280)
		a.lastVersion = a.island.StateVersion()
		return a.tester
	}
	if cur := a.island.StateVersion(); cur != a.lastVersion {
		a.tester.Frame()
		a.lastVersion = cur
	}
	return a.tester
}

// Inspect renders any pending state update and returns the full UI accessibility tree snapshot.
func (a *AutomationEndpoint) Inspect(ctx context.Context) (InspectSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return InspectSnapshot{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.snapshotLocked(), nil
}

func (a *AutomationEndpoint) snapshotLocked() InspectSnapshot {
	tt := a.ensureTesterLocked()
	acc := tt.AccessAll()
	nodes := make([]AutomationNode, 0, len(acc))
	for i, item := range acc {
		nodes = append(nodes, AutomationNode{
			Index:       i,
			Role:        fmt.Sprint(item.Role),
			Name:        item.Name,
			Description: item.Description,
			Value:       item.Value,
			Bounds:      item.Bounds,
			Disabled:    item.Disabled,
			Focusable:   item.Focusable,
			Focused:     item.Focused,
		})
	}
	var terms []TerminalInfo
	if a.terminals != nil {
		terms = a.terminals.List()
	}
	return InspectSnapshot{
		WebURL:       WorkbenchURL(a.webCfg),
		StateVersion: a.island.StateVersion(),
		RenderCount:  a.island.RenderCount(),
		FramePending: tt.FramePending(),
		Island:       a.island.State(),
		Texts:        tt.Texts(),
		Nodes:        nodes,
		Terminals:    terms,
	}
}

// Click finds a UI element by exact label/name or description substring and clicks it via ui.Tester.
func (a *AutomationEndpoint) Click(ctx context.Context, target string) (ClickResult, error) {
	if err := ctx.Err(); err != nil {
		return ClickResult{}, err
	}
	target = strings.TrimSpace(target)
	if target == "" {
		return ClickResult{}, errors.New("automation: click target is required")
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	start := time.Now()
	tt := a.ensureTesterLocked()
	matched := target

	// First try direct MyGo ui.Tester label match, else search accessible nodes by name/description.
	if err := tt.Click(target); err != nil {
		node, ok := findTargetNode(tt.AccessAll(), target)
		if !ok {
			return ClickResult{}, fmt.Errorf("automation: target %q not found (%v)", target, err)
		}
		if node.Bounds.W <= 0 || node.Bounds.H <= 0 {
			return ClickResult{}, fmt.Errorf("automation: target %q has empty bounds", target)
		}
		matched = node.Name
		if node.Description != "" {
			matched = node.Description
		}
		cx := node.Bounds.X + node.Bounds.W/2
		cy := node.Bounds.Y + node.Bounds.H/2
		tt.ClickAt(cx, cy)
	}
	a.lastVersion = a.island.StateVersion()

	return ClickResult{
		Target:     target,
		Matched:    matched,
		DurationMs: float64(time.Since(start).Nanoseconds()) / 1e6,
		Snapshot:   a.snapshotLocked(),
	}, nil
}

func findTargetNode(nodes []ui.AccessInfo, target string) (ui.AccessInfo, bool) {
	for _, n := range nodes {
		if n.Name == target || n.Description == target {
			return n, true
		}
	}
	lower := strings.ToLower(target)
	for _, n := range nodes {
		if strings.Contains(strings.ToLower(n.Description), lower) ||
			strings.Contains(strings.ToLower(n.Name), lower) {
			return n, true
		}
	}
	return ui.AccessInfo{}, false
}

// CapturePNG renders the current Island UI frame as a PNG image.
func (a *AutomationEndpoint) CapturePNG(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tt := a.ensureTesterLocked()
	var buf bytes.Buffer
	if err := png.Encode(&buf, tt.Image()); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Handler exposes HTTP automation endpoints (`GET /inspect`, `POST /click`, `GET /capture.png`, `GET /health`).
func (a *AutomationEndpoint) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		snap, err := a.Inspect(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"framePending": snap.FramePending,
			"stateVersion": snap.StateVersion,
		})
	})
	mux.HandleFunc("GET /inspect", func(w http.ResponseWriter, r *http.Request) {
		snap, err := a.Inspect(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, snap)
	})
	mux.HandleFunc("POST /click", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Target string `json:"target"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		res, err := a.Click(r.Context(), body.Target)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
	mux.HandleFunc("GET /capture.png", func(w http.ResponseWriter, r *http.Request) {
		data, err := a.CapturePNG(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	})
	return mux
}

type autoRPCReq struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type autoRPCResp struct {
	ID     json.RawMessage `json:"id"`
	Result any             `json:"result,omitempty"`
	Error  *autoRPCError   `json:"error,omitempty"`
}

type autoRPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ListenUnix starts a newline-delimited JSON automation socket at sockPath until ctx cancels.
func (a *AutomationEndpoint) ListenUnix(ctx context.Context, sockPath string) (net.Listener, <-chan struct{}, error) {
	if strings.TrimSpace(sockPath) == "" {
		return nil, nil, errors.New("automation: empty socket path")
	}
	if err := os.MkdirAll(filepath.Dir(sockPath), 0o700); err != nil {
		return nil, nil, err
	}
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, nil, err
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(sockPath, 0o600)
	}

	done := make(chan struct{})
	var wg sync.WaitGroup

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	go func() {
		defer close(done)
		defer wg.Wait()
		defer func() { _ = os.Remove(sockPath) }()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func(c net.Conn) {
				defer wg.Done()
				a.serveUnixConn(ctx, c)
			}(conn)
		}
	}()

	return ln, done, nil
}

func (a *AutomationEndpoint) serveUnixConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	enc := json.NewEncoder(conn)
	enc.SetEscapeHTML(false)

	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		resp := a.handleRPC(ctx, line)
		if err := enc.Encode(resp); err != nil {
			return
		}
	}
}

func (a *AutomationEndpoint) handleRPC(ctx context.Context, line []byte) autoRPCResp {
	var req autoRPCReq
	if err := json.Unmarshal(line, &req); err != nil {
		return autoRPCResp{Error: &autoRPCError{Code: "parse_error", Message: err.Error()}}
	}
	resp := autoRPCResp{ID: req.ID}

	switch req.Method {
	case "inspect", "tree":
		snap, err := a.Inspect(ctx)
		if err != nil {
			resp.Error = &autoRPCError{Code: "failed", Message: err.Error()}
			return resp
		}
		resp.Result = snap
		return resp

	case "click", "act":
		var p struct {
			Target string `json:"target"`
			Key    string `json:"key"`
			Label  string `json:"label"`
		}
		if len(bytes.TrimSpace(req.Params)) > 0 {
			if err := json.Unmarshal(req.Params, &p); err != nil {
				resp.Error = &autoRPCError{Code: "invalid_request", Message: err.Error()}
				return resp
			}
		}
		target := firstNonEmpty(p.Target, p.Key, p.Label)
		res, err := a.Click(ctx, target)
		if err != nil {
			resp.Error = &autoRPCError{Code: "no_element", Message: err.Error()}
			return resp
		}
		resp.Result = res
		return resp

	case "idle":
		snap, err := a.Inspect(ctx)
		if err != nil {
			resp.Error = &autoRPCError{Code: "failed", Message: err.Error()}
			return resp
		}
		if snap.FramePending {
			resp.Error = &autoRPCError{Code: "timeout", Message: "island view still has pending frames"}
			return resp
		}
		resp.Result = map[string]bool{"settled": true}
		return resp

	case "capture":
		pngBytes, err := a.CapturePNG(ctx)
		if err != nil {
			resp.Error = &autoRPCError{Code: "failed", Message: err.Error()}
			return resp
		}
		resp.Result = map[string]any{"png": pngBytes}
		return resp

	default:
		resp.Error = &autoRPCError{Code: "unknown_method", Message: fmt.Sprintf("unknown method %q", req.Method)}
		return resp
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
