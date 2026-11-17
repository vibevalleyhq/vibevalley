package link

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
)

const (
	// MaxFrameBytes is the per-frame wire size limit above which payloads split
	// into interleaved stream chunks to prevent head-of-line blocking.
	MaxFrameBytes = 64 * 1024

	// DefaultMaxMessageBytes caps reassembled chunked frames and WebSocket messages.
	DefaultMaxMessageBytes = 32 * 1024 * 1024

	maxConcurrentChunkStreams = 1024
)

var (
	ErrTransportClosed  = errors.New("link: transport closed")
	ErrLinkClosed       = errors.New("link: closed")
	ErrHeartbeatTimeout = errors.New("link: heartbeat timeout")
	ErrHandshakeFailed  = errors.New("link: handshake failed")
	ErrInvalidFrame     = errors.New("link: invalid frame")
	ErrFrameTooLarge    = errors.New("link: frame exceeds maximum message size")
)

// FrameTransport carries discrete byte frames across in-process IPC or network transports.
type FrameTransport interface {
	Send(ctx context.Context, frame []byte) error
	Recv(ctx context.Context) ([]byte, error)
	Close() error
}

// FrameKind identifies the message type multiplexed over a Link.
type FrameKind string

const (
	FrameHello     FrameKind = "hello"
	FrameHelloAck  FrameKind = "hello_ack"
	FramePing      FrameKind = "ping"
	FramePong      FrameKind = "pong"
	FrameChunk     FrameKind = "chunk"
	FrameRPCReq    FrameKind = "rpc_req"
	FrameRPCRes    FrameKind = "rpc_res"
	FrameRPCCancel FrameKind = "rpc_cancel"
	FrameWatchOpen FrameKind = "watch_open"
	FrameWatchPush FrameKind = "watch_push"
	FrameWatchStop FrameKind = "watch_stop"
	FrameWatchEnd  FrameKind = "watch_end"
)

// RPCError carries a structured error code and message across the Link boundary.
type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string {
	if e == nil {
		return ""
	}
	if e.Code == "" {
		return e.Message
	}
	return e.Code + ": " + e.Message
}

func (e *RPCError) Unwrap() error {
	if e == nil {
		return nil
	}
	switch e.Code {
	case "deadline_exceeded":
		return context.DeadlineExceeded
	case "canceled":
		return context.Canceled
	default:
		return nil
	}
}

// Frame is the wire envelope exchanged over a FrameTransport.
type Frame struct {
	Kind      FrameKind       `json:"kind"`
	Principal *Principal      `json:"principal,omitempty"`
	Error     *RPCError       `json:"error,omitempty"`
	ID        string          `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	TimeoutMs int64           `json:"timeoutMs,omitempty"`
	Target    string          `json:"target,omitempty"`
	FromRev   int64           `json:"fromRev,omitempty"`
	Rev       int64           `json:"rev,omitempty"`
	Ops       []delta.Op      `json:"ops,omitempty"`
	Retired   bool            `json:"retired,omitempty"`
	Overflow  bool            `json:"overflow,omitempty"`
	StreamID  string          `json:"streamId,omitempty"`
	Seq       int             `json:"seq,omitempty"`
	Total     int             `json:"total,omitempty"`
	Final     bool            `json:"final,omitempty"`
	Data      []byte          `json:"data,omitempty"`
}

func (f Frame) isControlPriority() bool {
	switch f.Kind {
	case FrameHello, FrameHelloAck, FramePing, FramePong, FrameRPCCancel, FrameWatchStop:
		return true
	default:
		return false
	}
}

func splitFrameChunks(streamID string, raw []byte, maxFrameBytes int) ([][]byte, error) {
	if maxFrameBytes < 512 {
		maxFrameBytes = 512
	}
	// Reserve JSON envelope overhead for {"kind":"chunk","streamId":...,"seq":...,"total":...,"final":true,"data":""}.
	const headerReserve = 256
	rawPerChunk := max(1, (maxFrameBytes-headerReserve)*3/4)
	total := (len(raw) + rawPerChunk - 1) / rawPerChunk
	if total == 0 {
		total = 1
	}

	chunks := make([][]byte, 0, total)
	seq := 0
	for offset := 0; offset < len(raw); {
		step := min(rawPerChunk, len(raw)-offset)
		for {
			chunkFrame := Frame{
				Kind:     FrameChunk,
				StreamID: streamID,
				Seq:      seq,
				Total:    total,
				Final:    offset+step >= len(raw),
				Data:     raw[offset : offset+step],
			}
			encoded, err := json.Marshal(chunkFrame)
			if err != nil {
				return nil, err
			}
			if len(encoded) <= maxFrameBytes || step <= 1 {
				if len(encoded) > maxFrameBytes {
					return nil, fmt.Errorf("%w: chunk envelope %d > %d", ErrFrameTooLarge, len(encoded), maxFrameBytes)
				}
				chunks = append(chunks, encoded)
				break
			}
			step = max(1, step*3/4)
		}
		offset += step
		seq++
	}
	return chunks, nil
}

type chunkStream struct {
	expectedSeq int
	buf         bytes.Buffer
}

type chunkReassembler struct {
	maxMessageBytes int
	streams         map[string]*chunkStream
}

func newChunkReassembler(maxMessageBytes int) *chunkReassembler {
	if maxMessageBytes <= 0 {
		maxMessageBytes = DefaultMaxMessageBytes
	}
	return &chunkReassembler{
		maxMessageBytes: maxMessageBytes,
		streams:         make(map[string]*chunkStream),
	}
}

func (r *chunkReassembler) push(f Frame) (*Frame, error) {
	if f.StreamID == "" || f.Seq < 0 {
		return nil, fmt.Errorf("%w: malformed chunk header", ErrInvalidFrame)
	}
	cs, ok := r.streams[f.StreamID]
	if !ok {
		if f.Seq != 0 {
			return nil, fmt.Errorf("%w: unexpected first chunk seq %d for stream %q", ErrInvalidFrame, f.Seq, f.StreamID)
		}
		if len(r.streams) >= maxConcurrentChunkStreams {
			return nil, fmt.Errorf("%w: too many active chunk streams", ErrFrameTooLarge)
		}
		cs = &chunkStream{}
		r.streams[f.StreamID] = cs
	}
	if f.Seq != cs.expectedSeq {
		delete(r.streams, f.StreamID)
		return nil, fmt.Errorf("%w: out-of-order chunk seq %d != %d", ErrInvalidFrame, f.Seq, cs.expectedSeq)
	}
	if cs.buf.Len()+len(f.Data) > r.maxMessageBytes {
		delete(r.streams, f.StreamID)
		return nil, fmt.Errorf("%w: reassembled message exceeds %d bytes", ErrFrameTooLarge, r.maxMessageBytes)
	}
	cs.buf.Write(f.Data)
	cs.expectedSeq++
	if !f.Final {
		return nil, nil
	}
	delete(r.streams, f.StreamID)
	var assembled Frame
	if err := json.Unmarshal(cs.buf.Bytes(), &assembled); err != nil {
		return nil, fmt.Errorf("%w: chunked payload json: %v", ErrInvalidFrame, err)
	}
	if assembled.Kind == FrameChunk {
		return nil, fmt.Errorf("%w: nested chunk frame", ErrInvalidFrame)
	}
	return &assembled, nil
}

func (r *chunkReassembler) clear() {
	clear(r.streams)
}
