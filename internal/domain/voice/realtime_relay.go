package voice

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

	wsOpContinuation byte = 0x0
	wsOpText         byte = 0x1
	wsOpBinary       byte = 0x2
	wsOpClose        byte = 0x8
	wsOpPing         byte = 0x9
	wsOpPong         byte = 0xA

	defaultWSDialTimeout   = 15 * time.Second
	defaultMaxWSFrameBytes = 16 << 20 // 16 MiB
	wsCloseWriteTimeout    = 500 * time.Millisecond
)

var (
	// ErrRealtimeHandshake indicates an invalid WebSocket upgrade or upstream handshake rejection.
	ErrRealtimeHandshake = errors.New("voice: realtime websocket handshake failed")
	// ErrRealtimeFrame indicates a malformed or oversized RFC 6455 WebSocket frame.
	ErrRealtimeFrame = errors.New("voice: invalid websocket frame")
)

// RelayConfig configures a bidirectional RFC 6455 WebSocket relay between a browser client and
// an upstream realtime voice endpoint (`ws://` or `wss://`).
type RelayConfig struct {
	UpstreamURL   string
	APIKey        string
	Headers       http.Header
	Subprotocols  []string
	TLSConfig     *tls.Config
	DialTimeout   time.Duration
	MaxFrameBytes int64
	OnOpen        func()
	OnClientFrame func(opcode byte, payload []byte) (forward bool, out []byte)
	OnServerFrame func(opcode byte, payload []byte) (forward bool, out []byte)
	Redact        func(string) string
}

// ServeRealtimeWS upgrades an incoming HTTP request to RFC 6455 WebSocket, connects to the
// configured upstream WebSocket server with server-injected credentials, and pumps frames
// bidirectionally until either side closes or r.Context() cancels.
func ServeRealtimeWS(w http.ResponseWriter, r *http.Request, cfg RelayConfig) error {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return fmt.Errorf("%w: method %s not allowed", ErrRealtimeHandshake, r.Method)
	}
	if !headerContainsToken(r.Header, "Upgrade", "websocket") || !headerContainsToken(r.Header, "Connection", "upgrade") {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return fmt.Errorf("%w: missing websocket upgrade headers", ErrRealtimeHandshake)
	}
	if ver := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")); ver != "" && ver != "13" {
		http.Error(w, "unsupported Sec-WebSocket-Version", http.StatusBadRequest)
		return fmt.Errorf("%w: unsupported Sec-WebSocket-Version %q", ErrRealtimeHandshake, ver)
	}
	wsKey := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if wsKey == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return fmt.Errorf("%w: missing Sec-WebSocket-Key", ErrRealtimeHandshake)
	}
	if strings.TrimSpace(cfg.UpstreamURL) == "" {
		http.Error(w, "upstream websocket URL missing", http.StatusBadGateway)
		return fmt.Errorf("%w: UpstreamURL is required", ErrRealtimeHandshake)
	}

	maxFrame := cfg.MaxFrameBytes
	if maxFrame <= 0 {
		maxFrame = defaultMaxWSFrameBytes
	}

	subprotocols := cfg.Subprotocols
	if len(subprotocols) == 0 {
		if rawProto := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Protocol")); rawProto != "" {
			for part := range strings.SplitSeq(rawProto, ",") {
				if p := strings.TrimSpace(part); p != "" {
					subprotocols = append(subprotocols, p)
				}
			}
		}
	}

	upstreamConn, negotiatedProto, err := dialUpstreamWS(r.Context(), cfg, subprotocols, maxFrame)
	if err != nil {
		http.Error(w, redactRelayString(err.Error(), cfg), http.StatusBadGateway)
		return err
	}

	browserConn, err := upgradeBrowserWS(w, wsKey, negotiatedProto, maxFrame)
	if err != nil {
		_ = upstreamConn.netConn.Close()
		return err
	}

	if cfg.OnOpen != nil {
		cfg.OnOpen()
	}

	return pumpBidirectionalWS(r.Context(), browserConn, upstreamConn, cfg)
}

type wsConn struct {
	netConn  net.Conn
	r        *bufio.Reader
	wMu      sync.Mutex
	isClient bool // client -> server frames must be masked; server -> client frames unmasked
	maxFrame int64
	closed   atomic.Bool
}

func upgradeBrowserWS(w http.ResponseWriter, wsKey, subprotocol string, maxFrame int64) (*wsConn, error) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket hijack unsupported", http.StatusInternalServerError)
		return nil, fmt.Errorf("%w: http.Hijacker unsupported", ErrRealtimeHandshake)
	}
	accept := computeWebSocketAccept(wsKey)

	netConn, rw, err := hj.Hijack()
	if err != nil {
		return nil, fmt.Errorf("%w: hijack: %v", ErrRealtimeHandshake, err)
	}

	var hdr strings.Builder
	hdr.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	hdr.WriteString("Upgrade: websocket\r\n")
	hdr.WriteString("Connection: Upgrade\r\n")
	hdr.WriteString("Sec-WebSocket-Accept: ")
	hdr.WriteString(accept)
	hdr.WriteString("\r\n")
	if subprotocol != "" {
		hdr.WriteString("Sec-WebSocket-Protocol: ")
		hdr.WriteString(subprotocol)
		hdr.WriteString("\r\n")
	}
	hdr.WriteString("\r\n")

	if _, err := rw.WriteString(hdr.String()); err != nil {
		_ = netConn.Close()
		return nil, fmt.Errorf("%w: write 101 response: %v", ErrRealtimeHandshake, err)
	}
	if err := rw.Flush(); err != nil {
		_ = netConn.Close()
		return nil, fmt.Errorf("%w: flush 101 response: %v", ErrRealtimeHandshake, err)
	}

	return &wsConn{
		netConn:  netConn,
		r:        rw.Reader,
		isClient: false,
		maxFrame: maxFrame,
	}, nil
}

func dialUpstreamWS(ctx context.Context, cfg RelayConfig, subprotocols []string, maxFrame int64) (*wsConn, string, error) {
	u, err := url.Parse(strings.TrimSpace(cfg.UpstreamURL))
	if err != nil {
		return nil, "", fmt.Errorf("%w: parse UpstreamURL: %v", ErrRealtimeHandshake, err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "ws" && scheme != "wss" {
		return nil, "", fmt.Errorf("%w: unsupported scheme %q", ErrRealtimeHandshake, u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return nil, "", fmt.Errorf("%w: upstream host is empty", ErrRealtimeHandshake)
	}
	port := u.Port()
	if port == "" {
		if scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	addr := net.JoinHostPort(host, port)

	timeout := cfg.DialTimeout
	if timeout <= 0 {
		timeout = defaultWSDialTimeout
	}
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	netDialer := &net.Dialer{Timeout: timeout}
	var conn net.Conn
	if scheme == "wss" {
		var tlsCfg *tls.Config
		if cfg.TLSConfig != nil {
			tlsCfg = cfg.TLSConfig.Clone()
		} else {
			tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
		}
		if tlsCfg.ServerName == "" {
			tlsCfg.ServerName = host
		}
		tlsDialer := &tls.Dialer{
			NetDialer: netDialer,
			Config:    tlsCfg,
		}
		conn, err = tlsDialer.DialContext(dialCtx, "tcp", addr)
	} else {
		conn, err = netDialer.DialContext(dialCtx, "tcp", addr)
	}
	if err != nil {
		return nil, "", fmt.Errorf("%w: dial %s: %v", ErrRealtimeHandshake, addr, err)
	}

	if deadline, ok := dialCtx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	stopWatcher := context.AfterFunc(dialCtx, func() {
		_ = conn.Close()
	})

	var nonce [16]byte
	if _, rErr := rand.Read(nonce[:]); rErr != nil {
		stopWatcher()
		_ = conn.Close()
		return nil, "", fmt.Errorf("%w: random key: %v", ErrRealtimeHandshake, rErr)
	}
	wsKey := base64.StdEncoding.EncodeToString(nonce[:])
	expectedAccept := computeWebSocketAccept(wsKey)

	reqURI := u.RequestURI()
	if reqURI == "" {
		reqURI = "/"
	}

	reqHeaders := make(http.Header)
	for k, vals := range cfg.Headers {
		for _, v := range vals {
			reqHeaders.Add(k, v)
		}
	}
	if key := strings.TrimSpace(cfg.APIKey); key != "" && reqHeaders.Get("Authorization") == "" {
		reqHeaders.Set("Authorization", "Bearer "+key)
	}
	if len(subprotocols) > 0 && reqHeaders.Get("Sec-WebSocket-Protocol") == "" {
		reqHeaders.Set("Sec-WebSocket-Protocol", strings.Join(subprotocols, ", "))
	}

	var reqBuf strings.Builder
	reqBuf.WriteString("GET ")
	reqBuf.WriteString(reqURI)
	reqBuf.WriteString(" HTTP/1.1\r\n")
	reqBuf.WriteString("Host: ")
	reqBuf.WriteString(u.Host)
	reqBuf.WriteString("\r\n")
	reqBuf.WriteString("Upgrade: websocket\r\n")
	reqBuf.WriteString("Connection: Upgrade\r\n")
	reqBuf.WriteString("Sec-WebSocket-Key: ")
	reqBuf.WriteString(wsKey)
	reqBuf.WriteString("\r\n")
	reqBuf.WriteString("Sec-WebSocket-Version: 13\r\n")

	headerKeys := make([]string, 0, len(reqHeaders))
	for k := range reqHeaders {
		lower := strings.ToLower(k)
		if lower == "host" || lower == "upgrade" || lower == "connection" || lower == "sec-websocket-key" || lower == "sec-websocket-version" {
			continue
		}
		headerKeys = append(headerKeys, k)
	}
	sort.Strings(headerKeys)
	for _, k := range headerKeys {
		for _, v := range reqHeaders.Values(k) {
			reqBuf.WriteString(k)
			reqBuf.WriteString(": ")
			reqBuf.WriteString(v)
			reqBuf.WriteString("\r\n")
		}
	}
	reqBuf.WriteString("\r\n")

	if err := writeAll(conn, []byte(reqBuf.String())); err != nil {
		stopWatcher()
		_ = conn.Close()
		return nil, "", fmt.Errorf("%w: send upgrade request: %v", ErrRealtimeHandshake, err)
	}

	br := bufio.NewReader(conn)
	fakeReq := &http.Request{Method: http.MethodGet, URL: u}
	resp, err := http.ReadResponse(br, fakeReq)
	stopWatcher()
	if err != nil {
		_ = conn.Close()
		return nil, "", fmt.Errorf("%w: read upgrade response: %v", ErrRealtimeHandshake, err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		_ = conn.Close()
		detail := redactRelayString(strings.TrimSpace(string(snippet)), cfg)
		if detail != "" {
			return nil, "", fmt.Errorf("%w: upstream status %d: %s", ErrRealtimeHandshake, resp.StatusCode, detail)
		}
		return nil, "", fmt.Errorf("%w: upstream status %d", ErrRealtimeHandshake, resp.StatusCode)
	}
	if !headerContainsToken(resp.Header, "Upgrade", "websocket") || resp.Header.Get("Sec-WebSocket-Accept") != expectedAccept {
		_ = conn.Close()
		return nil, "", fmt.Errorf("%w: invalid upstream Sec-WebSocket-Accept", ErrRealtimeHandshake)
	}
	_ = conn.SetDeadline(time.Time{})

	negotiated := strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Protocol"))
	return &wsConn{
		netConn:  conn,
		r:        br,
		isClient: true,
		maxFrame: maxFrame,
	}, negotiated, nil
}

func pumpBidirectionalWS(ctx context.Context, browser, upstream *wsConn, cfg RelayConfig) error {
	var (
		closeOnce sync.Once
		pumpDone  = make(chan struct{})
		errMu     sync.Mutex
		firstErr  error
	)
	recordErr := func(err error) {
		if err == nil || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
			return
		}
		errMu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		errMu.Unlock()
	}

	shutdown := func(code uint16, reason string) {
		closeOnce.Do(func() {
			cleanCode := sanitizeCloseCode(code)
			cleanReason := redactRelayString(reason, cfg)
			_ = browser.writeClose(cleanCode, cleanReason)
			_ = upstream.writeClose(cleanCode, cleanReason)
			browser.closed.Store(true)
			upstream.closed.Store(true)
			_ = browser.netConn.Close()
			_ = upstream.netConn.Close()
		})
	}

	var wg sync.WaitGroup
	wg.Add(2)

	// Browser -> Upstream (relay reads browser frames, writes masked frames to upstream).
	go func() {
		defer wg.Done()
		for {
			op, payload, err := browser.readMessage()
			if err != nil {
				if errors.Is(err, io.EOF) {
					code, reason := parseClosePayload(payload)
					shutdown(code, reason)
					return
				}
				if !browser.closed.Load() {
					recordErr(err)
				}
				shutdown(1002, "browser read error")
				return
			}
			forward := true
			out := payload
			if cfg.OnClientFrame != nil {
				forward, out = cfg.OnClientFrame(op, payload)
			}
			if !forward {
				continue
			}
			if err := upstream.writeFrame(true, op, out); err != nil {
				if !upstream.closed.Load() {
					recordErr(err)
				}
				shutdown(1011, "upstream write error")
				return
			}
		}
	}()

	// Upstream -> Browser (relay reads upstream frames, writes unmasked frames to browser).
	go func() {
		defer wg.Done()
		for {
			op, payload, err := upstream.readMessage()
			if err != nil {
				if errors.Is(err, io.EOF) {
					code, reason := parseClosePayload(payload)
					shutdown(code, reason)
					return
				}
				if !upstream.closed.Load() {
					recordErr(err)
				}
				shutdown(1011, "upstream read error")
				return
			}
			forward := true
			out := payload
			if cfg.OnServerFrame != nil {
				forward, out = cfg.OnServerFrame(op, payload)
			}
			if !forward {
				continue
			}
			if err := browser.writeFrame(true, op, out); err != nil {
				if !browser.closed.Load() {
					recordErr(err)
				}
				shutdown(1001, "browser write error")
				return
			}
		}
	}()

	ctxDone := make(chan struct{})
	go func() {
		defer close(ctxDone)
		select {
		case <-ctx.Done():
			shutdown(1001, "realtime session closed")
		case <-pumpDone:
		}
	}()

	wg.Wait()
	close(pumpDone)
	<-ctxDone

	errMu.Lock()
	defer errMu.Unlock()
	return firstErr
}

func (c *wsConn) writeFrame(fin bool, opcode byte, payload []byte) error {
	c.wMu.Lock()
	defer c.wMu.Unlock()

	var hdr [14]byte
	b0 := opcode & 0x0F
	if fin {
		b0 |= 0x80
	}
	hdr[0] = b0

	n := len(payload)
	var maskBit byte
	if c.isClient {
		maskBit = 0x80
	}

	hLen := 2
	switch {
	case n <= 125:
		hdr[1] = maskBit | byte(n)
	case n <= 65535:
		hdr[1] = maskBit | 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
		hLen = 4
	default:
		hdr[1] = maskBit | 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
		hLen = 10
	}

	var outPayload []byte
	if c.isClient {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		copy(hdr[hLen:hLen+4], mask[:])
		hLen += 4
		if n > 0 {
			outPayload = make([]byte, n)
			for i := range payload {
				outPayload[i] = payload[i] ^ mask[i%4]
			}
		}
	} else {
		outPayload = payload
	}

	if n == 0 {
		return writeAll(c.netConn, hdr[:hLen])
	}
	frame := make([]byte, hLen+n)
	copy(frame[:hLen], hdr[:hLen])
	copy(frame[hLen:], outPayload)
	return writeAll(c.netConn, frame)
}

func (c *wsConn) writeClose(code uint16, reason string) error {
	if len(reason) > 123 {
		reason = reason[:123]
	}
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload[:2], sanitizeCloseCode(code))
	copy(payload[2:], reason)
	_ = c.netConn.SetWriteDeadline(time.Now().Add(wsCloseWriteTimeout))
	err := c.writeFrame(true, wsOpClose, payload)
	_ = c.netConn.SetWriteDeadline(time.Time{})
	return err
}

func (c *wsConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.r, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin = (hdr[0] & 0x80) != 0
	if (hdr[0] & 0x70) != 0 {
		return false, 0, nil, fmt.Errorf("%w: non-zero RSV bits", ErrRealtimeFrame)
	}
	opcode = hdr[0] & 0x0F
	masked := (hdr[1] & 0x80) != 0
	length := uint64(hdr[1] & 0x7F)

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
		if (ext[0] & 0x80) != 0 {
			return false, 0, nil, fmt.Errorf("%w: invalid 64-bit length MSB", ErrRealtimeFrame)
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	if opcode >= 0x8 && (!fin || length > 125) {
		return false, 0, nil, fmt.Errorf("%w: invalid control frame", ErrRealtimeFrame)
	}
	maxBytes := c.maxFrame
	if maxBytes <= 0 {
		maxBytes = defaultMaxWSFrameBytes
	}
	if length > uint64(maxBytes) {
		return false, 0, nil, fmt.Errorf("%w: frame length %d exceeds max %d", ErrRealtimeFrame, length, maxBytes)
	}

	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.r, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}

	if length > 0 {
		payload = make([]byte, int(length))
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

func (c *wsConn) readMessage() (byte, []byte, error) {
	var (
		msgOp byte
		acc   []byte
	)
	maxBytes := c.maxFrame
	if maxBytes <= 0 {
		maxBytes = defaultMaxWSFrameBytes
	}

	for {
		fin, op, data, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case wsOpClose:
			return wsOpClose, data, io.EOF
		case wsOpPing:
			_ = c.writeFrame(true, wsOpPong, data)
			continue
		case wsOpPong:
			continue
		case wsOpContinuation:
			if msgOp == 0 {
				return 0, nil, fmt.Errorf("%w: unexpected continuation frame", ErrRealtimeFrame)
			}
			if int64(len(acc)+len(data)) > maxBytes {
				return 0, nil, fmt.Errorf("%w: message exceeds max %d", ErrRealtimeFrame, maxBytes)
			}
			acc = append(acc, data...)
		case wsOpText, wsOpBinary:
			if msgOp != 0 {
				return 0, nil, fmt.Errorf("%w: interleaved non-control frame during fragmented message", ErrRealtimeFrame)
			}
			msgOp = op
			acc = append(acc, data...)
		default:
			return 0, nil, fmt.Errorf("%w: unsupported opcode 0x%x", ErrRealtimeFrame, op)
		}
		if fin {
			return msgOp, acc, nil
		}
	}
}

func computeWebSocketAccept(wsKey string) string {
	sum := sha1.Sum([]byte(wsKey + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func headerContainsToken(h http.Header, name, target string) bool {
	for _, raw := range h.Values(name) {
		for tok := range strings.SplitSeq(raw, ",") {
			if strings.EqualFold(strings.TrimSpace(tok), target) {
				return true
			}
		}
	}
	return false
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func parseClosePayload(data []byte) (uint16, string) {
	if len(data) < 2 {
		return 1000, ""
	}
	code := binary.BigEndian.Uint16(data[:2])
	return sanitizeCloseCode(code), string(data[2:])
}

func sanitizeCloseCode(code uint16) uint16 {
	if code < 1000 || code == 1005 || code == 1006 || code == 1015 || code >= 5000 {
		return 1000
	}
	return code
}

func redactRelayString(text string, cfg RelayConfig) string {
	out := text
	if cfg.Redact != nil {
		out = cfg.Redact(out)
	}
	if cfg.APIKey != "" {
		out = strings.ReplaceAll(out, cfg.APIKey, "[redacted]")
	}
	return out
}
