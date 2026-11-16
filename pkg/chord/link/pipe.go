package link

import (
	"bytes"
	"context"
	"io"
	"sync"
)

const defaultPipeBuffer = 64

// PipeTransport is an in-memory bidirectional FrameTransport intended for
// in-process IPC such as vibe-desktop MyGo WebView bindings.
type PipeTransport struct {
	in        <-chan []byte
	out       chan<- []byte
	closed    chan struct{}
	closeOnce *sync.Once
}

// NewMemoryPipe returns a connected pair of in-memory FrameTransports.
// Closing either end immediately closes both sides.
func NewMemoryPipe(bufferSize ...int) (*PipeTransport, *PipeTransport) {
	capBuf := defaultPipeBuffer
	if len(bufferSize) > 0 && bufferSize[0] > 0 {
		capBuf = bufferSize[0]
	}
	aToB := make(chan []byte, capBuf)
	bToA := make(chan []byte, capBuf)
	closed := make(chan struct{})
	var closeOnce sync.Once

	a := &PipeTransport{
		in:        bToA,
		out:       aToB,
		closed:    closed,
		closeOnce: &closeOnce,
	}
	b := &PipeTransport{
		in:        aToB,
		out:       bToA,
		closed:    closed,
		closeOnce: &closeOnce,
	}
	return a, b
}

// Send copies frame and delivers it to the peer endpoint.
func (p *PipeTransport) Send(ctx context.Context, frame []byte) error {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-p.closed:
		return ErrTransportClosed
	default:
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	cp := bytes.Clone(frame)
	select {
	case <-p.closed:
		return ErrTransportClosed
	case <-ctx.Done():
		return ctx.Err()
	case p.out <- cp:
		return nil
	}
}

// Recv waits for the next frame from the peer endpoint.
func (p *PipeTransport) Recv(ctx context.Context) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-p.closed:
		return nil, io.EOF
	default:
	}
	select {
	case <-p.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	case frame := <-p.in:
		return frame, nil
	}
}

// Close closes both ends of the pipe idempotently.
func (p *PipeTransport) Close() error {
	p.closeOnce.Do(func() {
		close(p.closed)
	})
	return nil
}
