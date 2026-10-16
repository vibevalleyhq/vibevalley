package morph

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
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
	"time"
)

// A minimal RFC 6455 client for Console's `/stream/ws`: it reads text
// messages (reassembling fragments), answers pings, and closes. The TS port
// uses undici's WebSocket; Go's standard library has none.

type wsConn struct {
	conn    net.Conn
	reader  *bufio.Reader
	writeMu sync.Mutex
}

func dialWebSocket(target string, header http.Header) (*wsConn, error) {
	parsed, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	host := parsed.Host
	if parsed.Port() == "" {
		host += ":80"
	}
	conn, err := net.DialTimeout("tcp", host, 15*time.Second)
	if err != nil {
		return nil, err
	}
	keyBytes := make([]byte, 16)
	_, _ = rand.Read(keyBytes)
	key := base64.StdEncoding.EncodeToString(keyBytes)
	var request strings.Builder
	fmt.Fprintf(&request, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", parsed.RequestURI(), parsed.Host, key)
	for name, values := range header {
		for _, value := range values {
			fmt.Fprintf(&request, "%s: %s\r\n", name, value)
		}
	}
	request.WriteString("\r\n")
	if _, err := conn.Write([]byte(request.String())); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		conn.Close()
		return nil, fmt.Errorf("websocket upgrade refused: %s", response.Status)
	}
	return &wsConn{conn: conn, reader: reader}, nil
}

// write sends one masked frame (clients must mask).
func (c *wsConn) write(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	header := []byte{0x80 | opcode}
	switch {
	case len(payload) < 126:
		header = append(header, 0x80|byte(len(payload)))
	case len(payload) < 1<<16:
		header = append(header, 0x80|126, byte(len(payload)>>8), byte(len(payload)))
	default:
		header = append(header, 0x80|127)
		header = binary.BigEndian.AppendUint64(header, uint64(len(payload)))
	}
	mask := make([]byte, 4)
	_, _ = rand.Read(mask)
	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	_, err := c.conn.Write(append(append(header, mask...), masked...))
	return err
}

// readMessage returns the next text message; io.EOF once the peer closed.
func (c *wsConn) readMessage() ([]byte, error) {
	var message []byte
	for {
		first, err := c.reader.ReadByte()
		if err != nil {
			return nil, err
		}
		second, err := c.reader.ReadByte()
		if err != nil {
			return nil, err
		}
		length := uint64(second & 0x7f)
		switch length {
		case 126:
			var size [2]byte
			if _, err := io.ReadFull(c.reader, size[:]); err != nil {
				return nil, err
			}
			length = uint64(binary.BigEndian.Uint16(size[:]))
		case 127:
			var size [8]byte
			if _, err := io.ReadFull(c.reader, size[:]); err != nil {
				return nil, err
			}
			length = binary.BigEndian.Uint64(size[:])
		}
		var mask []byte
		if second&0x80 != 0 {
			mask = make([]byte, 4)
			if _, err := io.ReadFull(c.reader, mask); err != nil {
				return nil, err
			}
		}
		if length > 64<<20 {
			return nil, errors.New("websocket frame too large")
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.reader, payload); err != nil {
			return nil, err
		}
		if mask != nil {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch first & 0x0f {
		case 0x8: // close
			_ = c.write(0x8, nil)
			return nil, io.EOF
		case 0x9: // ping
			_ = c.write(0xA, payload)
			continue
		case 0xA: // pong
			continue
		}
		message = append(message, payload...)
		if first&0x80 != 0 {
			return message, nil
		}
	}
}

func (c *wsConn) close() {
	_ = c.write(0x8, nil)
	_ = c.conn.Close()
}
