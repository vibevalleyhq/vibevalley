package link

import (
	"bufio"
	"bytes"
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
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const wsAcceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	wsOpContinuation byte = 0x0
	wsOpText         byte = 0x1
	wsOpBinary       byte = 0x2
	wsOpClose        byte = 0x8
	wsOpPing         byte = 0x9
	wsOpPong         byte = 0xA
)

var (
	ErrWebSocketHandshake = errors.New("link: websocket handshake failed")
	ErrWebSocketProtocol  = errors.New("link: websocket protocol error")
)

type wsConfig struct {
	headers         http.Header
	tlsConfig       *tls.Config
	subprotocols    []string
	maxMessageBytes int
}

// WebSocketOption configures WebSocket dialing or upgrading.
type WebSocketOption func(*wsConfig)

// WithWebSocketHeaders adds custom HTTP headers to the WebSocket client upgrade request.
func WithWebSocketHeaders(h http.Header) WebSocketOption {
	return func(c *wsConfig) {
		if c.headers == nil {
			c.headers = make(http.Header)
		}
		for k, vals := range h {
			for _, v := range vals {
				c.headers.Add(k, v)
			}
		}
	}
}

// WithWebSocketTLSConfig sets the TLS config for wss:// connections.
func WithWebSocketTLSConfig(cfg *tls.Config) WebSocketOption {
	return func(c *wsConfig) {
		c.tlsConfig = cfg
	}
}

// WithWebSocketSubprotocols configures Sec-WebSocket-Protocol negotiation.
func WithWebSocketSubprotocols(protos ...string) WebSocketOption {
	return func(c *wsConfig) {
		c.subprotocols = append([]string(nil), protos...)
	}
}

// WithWebSocketMaxMessageBytes caps the maximum single WebSocket message size.
func WithWebSocketMaxMessageBytes(n int) WebSocketOption {
	return func(c *wsConfig) {
		if n > 0 {
			c.maxMessageBytes = n
		}
	}
}

// WebSocketTransport implements FrameTransport over pure-stdlib RFC 6455 WebSocket.
type WebSocketTransport struct {
	conn        net.Conn
	br          *bufio.Reader
	isClient    bool
	maxPayload  int
	subprotocol string

	readMu    sync.Mutex
	writeMu   sync.Mutex
	closed    atomic.Bool
	closeOnce sync.Once
}

// Subprotocol returns the negotiated Sec-WebSocket-Protocol value, if any.
func (t *WebSocketTransport) Subprotocol() string {
	return t.subprotocol
}

// UpgradeWebSocket performs an RFC 6455 server handshake on w and r and returns a FrameTransport.
func UpgradeWebSocket(w http.ResponseWriter, r *http.Request, opts ...WebSocketOption) (*WebSocketTransport, error) {
	cfg := wsConfig{maxMessageBytes: DefaultMaxMessageBytes}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return nil, fmt.Errorf("%w: method %s", ErrWebSocketHandshake, r.Method)
	}
	if !headerHasToken(r.Header, "Connection", "upgrade") || !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
		return nil, fmt.Errorf("%w: missing Upgrade/Connection headers", ErrWebSocketHandshake)
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		http.Error(w, "unsupported websocket version", http.StatusBadRequest)
		return nil, fmt.Errorf("%w: unsupported version %q", ErrWebSocketHandshake, r.Header.Get("Sec-WebSocket-Version"))
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	decodedKey, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decodedKey) != 16 {
		http.Error(w, "invalid Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, fmt.Errorf("%w: invalid Sec-WebSocket-Key", ErrWebSocketHandshake)
	}

	selectedProto := selectSubprotocol(r.Header, cfg.subprotocols)

	rc := http.NewResponseController(w)
	conn, rw, err := rc.Hijack()
	if err != nil {
		return nil, fmt.Errorf("%w: hijack: %v", ErrWebSocketHandshake, err)
	}

	var respBuf bytes.Buffer
	respBuf.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	respBuf.WriteString("Upgrade: websocket\r\n")
	respBuf.WriteString("Connection: Upgrade\r\n")
	respBuf.WriteString("Sec-WebSocket-Accept: ")
	respBuf.WriteString(computeWebSocketAccept(key))
	respBuf.WriteString("\r\n")
	if selectedProto != "" {
		respBuf.WriteString("Sec-WebSocket-Protocol: ")
		respBuf.WriteString(selectedProto)
		respBuf.WriteString("\r\n")
	}
	respBuf.WriteString("\r\n")

	if _, err := rw.Write(respBuf.Bytes()); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("%w: write 101: %v", ErrWebSocketHandshake, err)
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("%w: flush 101: %v", ErrWebSocketHandshake, err)
	}

	return &WebSocketTransport{
		conn:        conn,
		br:          rw.Reader,
		isClient:    false,
		maxPayload:  cfg.maxMessageBytes,
		subprotocol: selectedProto,
	}, nil
}

// WebSocketHandler wraps UpgradeWebSocket into an http.HandlerFunc that invokes onAccept
// for each successfully upgraded connection.
func WebSocketHandler(onAccept func(*WebSocketTransport, *http.Request), opts ...WebSocketOption) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tr, err := UpgradeWebSocket(w, r, opts...)
		if err != nil {
			return
		}
		if onAccept != nil {
			onAccept(tr, r)
		} else {
			_ = tr.Close()
		}
	}
}

// DialWebSocket dials an RFC 6455 WebSocket endpoint (ws:// or wss://) using pure stdlib.
func DialWebSocket(ctx context.Context, rawURL string, opts ...WebSocketOption) (*WebSocketTransport, *http.Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cfg := wsConfig{maxMessageBytes: DefaultMaxMessageBytes}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: parse url: %v", ErrWebSocketHandshake, err)
	}

	var useTLS bool
	switch strings.ToLower(u.Scheme) {
	case "ws", "http":
		useTLS = false
	case "wss", "https":
		useTLS = true
	default:
		return nil, nil, fmt.Errorf("%w: unsupported scheme %q", ErrWebSocketHandshake, u.Scheme)
	}

	addr := u.Host
	if u.Port() == "" {
		if useTLS {
			addr = net.JoinHostPort(u.Hostname(), "443")
		} else {
			addr = net.JoinHostPort(u.Hostname(), "80")
		}
	}

	var conn net.Conn
	dialer := &net.Dialer{}
	if useTLS {
		td := &tls.Dialer{NetDialer: dialer, Config: cfg.tlsConfig}
		conn, err = td.DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("%w: dial: %v", ErrWebSocketHandshake, err)
	}

	stopCancel := context.AfterFunc(ctx, func() {
		_ = conn.SetDeadline(time.Unix(0, 1))
	})
	cleanupDeadline := true
	defer func() {
		stopCancel()
		if cleanupDeadline {
			_ = conn.Close()
		}
	}()

	var keyBytes [16]byte
	if _, err := io.ReadFull(rand.Reader, keyBytes[:]); err != nil {
		return nil, nil, fmt.Errorf("%w: random key: %v", ErrWebSocketHandshake, err)
	}
	clientKey := base64.StdEncoding.EncodeToString(keyBytes[:])

	reqURI := u.RequestURI()
	if reqURI == "" {
		reqURI = "/"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: build request: %v", ErrWebSocketHandshake, err)
	}

	var reqBuf bytes.Buffer
	fmt.Fprintf(&reqBuf, "GET %s HTTP/1.1\r\n", reqURI)
	fmt.Fprintf(&reqBuf, "Host: %s\r\n", u.Host)
	reqBuf.WriteString("Upgrade: websocket\r\n")
	reqBuf.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&reqBuf, "Sec-WebSocket-Key: %s\r\n", clientKey)
	reqBuf.WriteString("Sec-WebSocket-Version: 13\r\n")
	if len(cfg.subprotocols) > 0 {
		fmt.Fprintf(&reqBuf, "Sec-WebSocket-Protocol: %s\r\n", strings.Join(cfg.subprotocols, ", "))
	}
	for k, vals := range cfg.headers {
		canon := http.CanonicalHeaderKey(k)
		switch canon {
		case "Host", "Upgrade", "Connection", "Sec-Websocket-Key", "Sec-Websocket-Version", "Sec-Websocket-Protocol":
			continue
		}
		for _, v := range vals {
			fmt.Fprintf(&reqBuf, "%s: %s\r\n", canon, v)
		}
	}
	reqBuf.WriteString("\r\n")

	if _, err := conn.Write(reqBuf.Bytes()); err != nil {
		return nil, nil, fmt.Errorf("%w: write upgrade: %v", ErrWebSocketHandshake, err)
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, fmt.Errorf("%w: read response: %v", ErrWebSocketHandshake, err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		return nil, resp, fmt.Errorf("%w: unexpected HTTP status %d", ErrWebSocketHandshake, resp.StatusCode)
	}
	if !headerHasToken(resp.Header, "Connection", "upgrade") || !strings.EqualFold(strings.TrimSpace(resp.Header.Get("Upgrade")), "websocket") {
		return nil, resp, fmt.Errorf("%w: invalid upgrade response headers", ErrWebSocketHandshake)
	}
	expectedAccept := computeWebSocketAccept(clientKey)
	if strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Accept")) != expectedAccept {
		return nil, resp, fmt.Errorf("%w: Sec-WebSocket-Accept mismatch", ErrWebSocketHandshake)
	}

	stopCancel()
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, resp, fmt.Errorf("%w: clear deadline: %v", ErrWebSocketHandshake, err)
	}
	cleanupDeadline = false

	return &WebSocketTransport{
		conn:        conn,
		br:          br,
		isClient:    true,
		maxPayload:  cfg.maxMessageBytes,
		subprotocol: strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Protocol")),
	}, resp, nil
}

// Send writes a complete frame as an RFC 6455 text message.
func (t *WebSocketTransport) Send(ctx context.Context, frame []byte) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if t.closed.Load() {
		return ErrTransportClosed
	}
	if len(frame) > t.maxPayload {
		return ErrFrameTooLarge
	}
	return t.writeFrame(wsOpText, frame)
}

// Recv reads the next complete data message, automatically responding to Ping frames
// and honoring ctx cancellation via read deadlines.
func (t *WebSocketTransport) Recv(ctx context.Context) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	t.readMu.Lock()
	defer t.readMu.Unlock()

	if t.closed.Load() {
		return nil, io.EOF
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if ctx.Done() != nil {
		stop := context.AfterFunc(ctx, func() {
			_ = t.conn.SetReadDeadline(time.Unix(0, 1))
		})
		defer func() {
			if !stop() && !t.closed.Load() {
				_ = t.conn.SetReadDeadline(time.Time{})
			}
		}()
	}

	var msgBuf []byte
	inFragment := false

	for {
		fin, opcode, payload, err := t.readSingleFrame()
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if t.closed.Load() {
				return nil, io.EOF
			}
			return nil, err
		}

		switch opcode {
		case wsOpClose:
			_ = t.writeFrame(wsOpClose, nil)
			_ = t.Close()
			return nil, io.EOF
		case wsOpPing:
			if err := t.writeFrame(wsOpPong, payload); err != nil {
				if t.closed.Load() {
					return nil, io.EOF
				}
				return nil, err
			}
			continue
		case wsOpPong:
			continue
		case wsOpText, wsOpBinary:
			if inFragment {
				_ = t.Close()
				return nil, fmt.Errorf("%w: unexpected data frame inside fragmented message", ErrWebSocketProtocol)
			}
			if fin {
				return payload, nil
			}
			inFragment = true
			msgBuf = append(msgBuf, payload...)
		case wsOpContinuation:
			if !inFragment {
				_ = t.Close()
				return nil, fmt.Errorf("%w: unexpected continuation frame", ErrWebSocketProtocol)
			}
			if len(msgBuf)+len(payload) > t.maxPayload {
				_ = t.Close()
				return nil, ErrFrameTooLarge
			}
			msgBuf = append(msgBuf, payload...)
			if fin {
				return msgBuf, nil
			}
		default:
			_ = t.Close()
			return nil, fmt.Errorf("%w: unknown opcode 0x%x", ErrWebSocketProtocol, opcode)
		}
	}
}

// Close immediately closes the underlying network connection idempotently.
func (t *WebSocketTransport) Close() error {
	var err error
	t.closeOnce.Do(func() {
		t.closed.Store(true)
		err = t.conn.Close()
	})
	return err
}

func (t *WebSocketTransport) readSingleFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err := io.ReadFull(t.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	b0, b1 := hdr[0], hdr[1]
	if b0&0x70 != 0 {
		_ = t.Close()
		return false, 0, nil, fmt.Errorf("%w: non-zero RSV bits", ErrWebSocketProtocol)
	}
	fin = b0&0x80 != 0
	opcode = b0 & 0x0F
	masked := b1&0x80 != 0

	// RFC 6455 section 5.1: client->server frames MUST be masked; server->client MUST NOT.
	if (!t.isClient && !masked) || (t.isClient && masked) {
		_ = t.Close()
		return false, 0, nil, fmt.Errorf("%w: invalid mask bit (isClient=%v masked=%v)", ErrWebSocketProtocol, t.isClient, masked)
	}

	var length uint64
	switch lenCode := b1 & 0x7F; lenCode {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(t.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(t.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
		if length&(1<<63) != 0 {
			_ = t.Close()
			return false, 0, nil, fmt.Errorf("%w: invalid MSB in 64-bit length", ErrWebSocketProtocol)
		}
	default:
		length = uint64(lenCode)
	}

	// RFC 6455 section 5.5: control frames cannot be fragmented or > 125 bytes.
	if opcode >= 0x8 {
		if !fin || length > 125 {
			_ = t.Close()
			return false, 0, nil, fmt.Errorf("%w: invalid control frame", ErrWebSocketProtocol)
		}
	}
	if length > uint64(t.maxPayload) {
		_ = t.Close()
		return false, 0, nil, ErrFrameTooLarge
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(t.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}

	if length > 0 {
		payload = make([]byte, int(length))
		if _, err := io.ReadFull(t.br, payload); err != nil {
			return false, 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i&3]
			}
		}
	}
	return fin, opcode, payload, nil
}

func (t *WebSocketTransport) writeFrame(opcode byte, payload []byte) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()

	if t.closed.Load() {
		return ErrTransportClosed
	}

	n := len(payload)
	headerSize := 2
	if n >= 126 && n <= 65535 {
		headerSize += 2
	} else if n > 65535 {
		headerSize += 8
	}
	if t.isClient {
		headerSize += 4
	}

	pkt := make([]byte, headerSize+n)
	pkt[0] = 0x80 | opcode
	pos := 2
	switch {
	case n < 126:
		pkt[1] = byte(n)
	case n <= 65535:
		pkt[1] = 126
		binary.BigEndian.PutUint16(pkt[2:4], uint16(n))
		pos = 4
	default:
		pkt[1] = 127
		binary.BigEndian.PutUint64(pkt[2:10], uint64(n))
		pos = 10
	}

	if t.isClient {
		pkt[1] |= 0x80
		var maskKey [4]byte
		if _, err := io.ReadFull(rand.Reader, maskKey[:]); err != nil {
			return err
		}
		copy(pkt[pos:pos+4], maskKey[:])
		pos += 4
		for i := range payload {
			pkt[pos+i] = payload[i] ^ maskKey[i&3]
		}
	} else if n > 0 {
		copy(pkt[pos:], payload)
	}

	return writeAll(t.conn, pkt)
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		data = data[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func computeWebSocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsAcceptGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for part := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func selectSubprotocol(h http.Header, supported []string) string {
	if len(supported) == 0 {
		return ""
	}
	for _, v := range h.Values("Sec-WebSocket-Protocol") {
		for req := range strings.SplitSeq(v, ",") {
			req = strings.TrimSpace(req)
			for _, candidate := range supported {
				if req == candidate {
					return candidate
				}
			}
		}
	}
	return ""
}
