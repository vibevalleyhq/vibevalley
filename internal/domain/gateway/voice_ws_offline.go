package gateway

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

var offlineMossLiveActive atomic.Bool

type offlineWSConn struct {
	netConn net.Conn
	r       *bufio.Reader
	wMu     sync.Mutex
}

func (c *offlineWSConn) writeFrame(opcode byte, payload []byte) error {
	c.wMu.Lock()
	defer c.wMu.Unlock()
	var hdr [10]byte
	hdr[0] = 0x80 | (opcode & 0x0F)
	n := len(payload)
	hLen := 2
	switch {
	case n <= 125:
		hdr[1] = byte(n)
	case n <= 65535:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
		hLen = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
		hLen = 10
	}
	if _, err := c.netConn.Write(hdr[:hLen]); err != nil {
		return err
	}
	if n > 0 {
		if _, err := c.netConn.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

func (c *offlineWSConn) writeText(v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.writeFrame(0x1, raw)
}

func (c *offlineWSConn) writeClose(code uint16, reason string) {
	buf := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(buf[:2], code)
	copy(buf[2:], reason)
	_ = c.writeFrame(0x8, buf)
}

func (c *offlineWSConn) readSingleFrame() (fin bool, opcode byte, payload []byte, err error) {
	var b [2]byte
	if _, err = io.ReadFull(c.r, b[:]); err != nil {
		return false, 0, nil, err
	}
	fin = (b[0] & 0x80) != 0
	opcode = b[0] & 0x0F
	masked := (b[1] & 0x80) != 0
	length := uint64(b[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.r, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.r, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 2*1024*1024 {
		return false, 0, nil, errors.New("websocket frame too large")
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.r, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload = make([]byte, int(length))
	if length > 0 {
		if _, err = io.ReadFull(c.r, payload); err != nil {
			return false, 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
	}
	return fin, opcode, payload, nil
}

func (c *offlineWSConn) readMessage() (byte, []byte, error) {
	var msgOp byte
	var acc []byte
	for {
		fin, op, data, err := c.readSingleFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case 0x8:
			return 0x8, data, io.EOF
		case 0x9:
			_ = c.writeFrame(0xA, data)
			continue
		case 0xA:
			continue
		case 0x0:
			acc = append(acc, data...)
		default:
			msgOp = op
			acc = append(acc, data...)
		}
		if len(acc) > 2*1024*1024 {
			return 0, nil, errors.New("websocket message too large")
		}
		if fin {
			return msgOp, acc, nil
		}
	}
}

func (c *offlineWSConn) close() {
	_ = c.netConn.Close()
}

func isTrustedVoiceOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	reqHost := strings.ToLower(r.Host)
	if h, _, splitErr := net.SplitHostPort(reqHost); splitErr == nil {
		reqHost = h
	}
	return host != "" && host == reqHost
}

func upgradeOfflineWebSocket(w http.ResponseWriter, r *http.Request) (*offlineWSConn, error) {
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return nil, errors.New("websocket upgrade required")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("websocket hijack unsupported")
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])

	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	if _, err := fmt.Fprintf(
		rw,
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
		accept,
	); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &offlineWSConn{netConn: conn, r: rw.Reader}, nil
}

func writePlainError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg))
}

func (h *Handler) checkOfflineRealtimeBinding(kind string) (string, error) {
	if h.st == nil || h.st.Setting == nil {
		return "", errors.New("setting service unavailable")
	}
	st := h.st.Setting.ProviderStatus()
	b := st.Live
	if kind == "vision" {
		b = st.Vision
	}
	if b == nil {
		return "", fmt.Errorf("no %s model bound", kind)
	}
	for i := range st.Connections {
		c := st.Connections[i]
		if c.ID == b.Connection && c.Enabled && c.Key.Source != nil {
			return b.Model, nil
		}
	}
	return "", fmt.Errorf("connection %q is not configured", b.Connection)
}

func (h *Handler) handleOfflineVoiceWS(w http.ResponseWriter, r *http.Request, kind string) {
	if !offlineMediaEnabled() {
		writeError(w, newBizError(BizRouteNotFound, "unknown API route: "+r.URL.Path), BizRouteNotFound)
		return
	}
	if !isTrustedVoiceOrigin(r) {
		writePlainError(w, http.StatusForbidden, "not the farm's page")
		return
	}
	modelID, err := h.checkOfflineRealtimeBinding(kind)
	if err != nil {
		writePlainError(w, http.StatusConflict, err.Error())
		return
	}
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		writePlainError(w, http.StatusConflict, "realtime session closed")
		return
	}
	ws, err := upgradeOfflineWebSocket(w, r)
	if err != nil {
		writePlainError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer ws.close()

	if kind == "vision" {
		serveOfflineVisionSession(ws, firstNonEmpty(modelID, "moss-vl-vision"))
		return
	}
	if !offlineMossLiveActive.CompareAndSwap(false, true) {
		ws.writeClose(1013, "Live session already open")
		return
	}
	defer offlineMossLiveActive.Store(false)
	serveOfflineMossLiveSession(ws)
}

func serveOfflineMossLiveSession(ws *offlineWSConn) {
	answered := false
	camera := false
	screen := false
	liveAnswer := func(run, turn, text string) {
		_ = ws.writeText(map[string]any{"action": "response.audio.started", "data": map[string]any{"run_id": run, "turn_id": turn}})
		_ = ws.writeText(map[string]any{"action": "response.audio.context", "data": map[string]any{"run_id": run, "turn_id": turn, "chunk_id": run + "-chunk"}})
		_ = ws.writeFrame(0x2, make([]byte, 9600))
		_ = ws.writeText(map[string]any{"action": "response.audio.done", "data": map[string]any{"run_id": run, "turn_id": turn}})
		_ = ws.writeText(map[string]any{"action": "output.transcript.done", "data": map[string]any{"run_id": run, "turn_id": turn, "text": text}})
	}

	for {
		op, data, err := ws.readMessage()
		if err != nil {
			return
		}
		if op == 0x2 {
			if len(data) == 0 {
				continue
			}
			switch data[0] {
			case 0:
				if !answered {
					answered = true
					liveAnswer("fixture-run", "fixture-turn", "Realtime fixture answer.")
				}
			case 1:
				if !camera {
					camera = true
					liveAnswer("fixture-video-run-1", "fixture-video-1", "Virtual camera frame received.")
				}
			case 2:
				if !screen {
					screen = true
					liveAnswer("fixture-video-run-2", "fixture-video-2", "Virtual camera frame received.")
				}
			}
			continue
		}
		var ev struct {
			Action string `json:"action"`
			Type   string `json:"type"`
			RunID  string `json:"run_id"`
			TurnID string `json:"turn_id"`
		}
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		switch firstNonEmpty(ev.Action, ev.Type) {
		case "attach_session":
			_ = ws.writeText(map[string]any{
				"action": "session_attached",
				"data":   map[string]any{"session_id": "live-fixture", "memory_scope": "session", "delegation": "none"},
			})
		case "session.update":
			_ = ws.writeText(map[string]any{"action": "session.updated", "data": map[string]any{"error": ""}})
		case "playback.completed":
			if ev.RunID != "" && ev.TurnID != "" {
				_ = ws.writeText(map[string]any{
					"action": "response.ended",
					"data":   map[string]any{"run_id": ev.RunID, "turn_id": ev.TurnID, "status": "completed"},
				})
			}
		}
	}
}

func serveOfflineVisionSession(ws *offlineWSConn, model string) {
	_ = ws.writeText(map[string]any{
		"type":                "session.created",
		"session_id":          "visual-fixture",
		"task_id":             "visual-task",
		"model":               model,
		"turn_id":             0,
		"configure_timeout_s": 10,
		"protocol_version":    "1",
		"capabilities":        map[string]any{},
	})

	frameSeq := 0
	var frameTS float64
	promptPending := false
	respSeq := 0

	visualAnswer := func() {
		respID := fmt.Sprintf("visual-%d", respSeq)
		_ = ws.writeText(map[string]any{"type": "response.text.delta", "response_id": respID, "response_seq": respSeq, "turn_id": respSeq, "delta": "Virtual "})
		_ = ws.writeText(map[string]any{"type": "response.text.delta", "response_id": respID, "response_seq": respSeq, "turn_id": respSeq, "delta": "camera frame received."})
		_ = ws.writeText(map[string]any{"type": "response.done", "response_id": respID, "response_seq": respSeq, "turn_id": respSeq, "finish_reason": "stop", "boundary": "turn"})
		respSeq++
		promptPending = false
	}

	for {
		op, data, err := ws.readMessage()
		if err != nil {
			return
		}
		if op == 0x2 {
			_ = ws.writeText(map[string]any{
				"type":                    "input.frame.accepted",
				"seq_no":                  frameSeq,
				"timestamp":               frameTS,
				"final":                   false,
				"pending_events":          1,
				"interrupts_current_turn": false,
			})
			_ = ws.writeText(map[string]any{
				"type":           "input.frame.processed",
				"seq_no":         frameSeq,
				"timestamp":      frameTS,
				"final":          false,
				"pending_events": 0,
			})
			if promptPending {
				visualAnswer()
			}
			continue
		}
		var ev struct {
			Action    string  `json:"action"`
			Type      string  `json:"type"`
			SeqNo     int     `json:"seq_no"`
			Timestamp float64 `json:"timestamp"`
			Final     bool    `json:"final"`
		}
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		switch firstNonEmpty(ev.Action, ev.Type) {
		case "session.configure":
			_ = ws.writeText(map[string]any{
				"type":                     "session.configured",
				"session_id":               "visual-fixture",
				"request_id":               "fixture-request",
				"max_frame_bytes":          262144,
				"input_queue_capacity":     1,
				"max_tokens_per_turn":      32,
				"parked_request_timeout_s": 10,
				"context_limit":            32768,
			})
			_ = ws.writeText(map[string]any{
				"type":       "session.ready",
				"session_id": "visual-fixture",
				"request_id": "fixture-request",
				"turn_id":    0,
			})
		case "input.frame":
			frameSeq = ev.SeqNo
			frameTS = ev.Timestamp
			_ = ws.writeText(map[string]any{"type": "input.frame.ready", "seq_no": frameSeq})
		case "input.prompt":
			_ = ws.writeText(map[string]any{
				"type":                    "input.prompt.accepted",
				"seq_no":                  ev.SeqNo,
				"final":                   ev.Final,
				"pending_events":          1,
				"interrupts_current_turn": true,
			})
			promptPending = true
			if ev.Final {
				visualAnswer()
				_ = ws.writeText(map[string]any{
					"type":   "session.done",
					"reason": "completed",
					"usage": map[string]any{
						"vision_tokens":      10,
						"text_input_tokens":  4,
						"text_output_tokens": 6,
						"text_tokens":        10,
						"total_tokens":       20,
					},
				})
			}
		case "session.abort":
			_ = ws.writeText(map[string]any{"type": "session.done", "reason": "aborted"})
		}
	}
}
