package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"

	"github.com/egoist/mygo"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
)

const defaultBridgeBuffer = 128

// ChordFrameEvent delivers outbound Chord Link JSON frames to WebView pages
// that subscribe via MyGo's event listener instead of StreamFrames channels.
var ChordFrameEvent = mygo.NewEvent[string]("chord:frame")

var (
	bindBridgeOnce sync.Once
	bindBridgeErr  error
)

// BridgeTransport implements pkg/chord/link.FrameTransport over in-process Go channels
// wired directly to MyGo's bound IPC bridge, avoiding any loopback TCP listener.
type BridgeTransport struct {
	inbound   chan []byte
	outbound  chan []byte
	closed    chan struct{}
	closeOnce sync.Once

	mu       sync.Mutex
	onSend   func([]byte)
	window   *mygo.Window
	eventing bool
}

// BridgeTransportOptions configures a BridgeTransport.
type BridgeTransportOptions struct {
	BufferSize int
	Window     *mygo.Window
	OnSend     func([]byte)
}

// NewBridgeTransport allocates an in-process channel-backed FrameTransport for MyGo WebView IPC.
func NewBridgeTransport(opts BridgeTransportOptions) *BridgeTransport {
	capBuf := opts.BufferSize
	if capBuf <= 0 {
		capBuf = defaultBridgeBuffer
	}
	return &BridgeTransport{
		inbound:  make(chan []byte, capBuf),
		outbound: make(chan []byte, capBuf),
		closed:   make(chan struct{}),
		window:   opts.Window,
		onSend:   opts.OnSend,
		eventing: opts.Window != nil,
	}
}

// AttachWindow enables forwarding outbound frames via ChordFrameEvent to win in addition
// to the outbound channel.
func (t *BridgeTransport) AttachWindow(win *mygo.Window) {
	t.mu.Lock()
	t.window = win
	t.eventing = win != nil
	t.mu.Unlock()
}

// Send queues an outbound Chord Link frame for delivery to the WebView bridge.
func (t *BridgeTransport) Send(ctx context.Context, frame []byte) error {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-t.closed:
		return link.ErrTransportClosed
	default:
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	cp := bytes.Clone(frame)
	select {
	case <-t.closed:
		return link.ErrTransportClosed
	case <-ctx.Done():
		return ctx.Err()
	case t.outbound <- cp:
	}

	t.mu.Lock()
	win := t.window
	emit := t.eventing
	onSend := t.onSend
	t.mu.Unlock()

	if onSend != nil {
		onSend(bytes.Clone(cp))
	}
	if emit && win != nil && !win.IsDestroyed() {
		_ = ChordFrameEvent.Emit(win, string(cp))
	}
	return nil
}

// Recv waits for the next inbound Chord Link frame posted by the WebView page.
func (t *BridgeTransport) Recv(ctx context.Context) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-t.closed:
		return nil, io.EOF
	default:
	}
	select {
	case <-t.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	case frame := <-t.inbound:
		return frame, nil
	}
}

// PushInbound delivers a frame sent from the WebView page into Recv.
func (t *BridgeTransport) PushInbound(ctx context.Context, frame []byte) error {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-t.closed:
		return link.ErrTransportClosed
	default:
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	cp := bytes.Clone(frame)
	select {
	case <-t.closed:
		return link.ErrTransportClosed
	case <-ctx.Done():
		return ctx.Err()
	case t.inbound <- cp:
		return nil
	}
}

// PullOutbound reads the next outbound frame destined for the WebView page.
func (t *BridgeTransport) PullOutbound(ctx context.Context) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-t.closed:
		return nil, io.EOF
	default:
	}
	select {
	case <-t.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	case frame := <-t.outbound:
		return frame, nil
	}
}

// Close closes the transport idempotently and unblocks all waiting Send/Recv callers.
func (t *BridgeTransport) Close() error {
	t.closeOnce.Do(func() {
		close(t.closed)
	})
	return nil
}

// Done closes when the transport has been closed.
func (t *BridgeTransport) Done() <-chan struct{} {
	return t.closed
}

// ChordBridge is the Go service bound to MyGo (`ChordLink`) so apps/web speaks
// the exact Chord Link wire protocol over in-process bridge calls and channels.
type ChordBridge struct {
	transport *BridgeTransport
}

// NewChordBridge creates a ChordBridge around transport (creating one if nil).
func NewChordBridge(transport *BridgeTransport) *ChordBridge {
	if transport == nil {
		transport = NewBridgeTransport(BridgeTransportOptions{})
	}
	return &ChordBridge{transport: transport}
}

// ServerTransport returns the link.FrameTransport consumed by the Go-side Link server.
func (b *ChordBridge) ServerTransport() *BridgeTransport {
	return b.transport
}

// ClientTransport returns a link.FrameTransport adapter representing the WebView peer side.
func (b *ChordBridge) ClientTransport() link.FrameTransport {
	return &bridgePeerTransport{bridge: b}
}

// Ping reports bridge readiness to WebView callers.
func (b *ChordBridge) Ping(_ context.Context) string {
	return "pong"
}

// SendFrame accepts a serialized Chord Link frame from the WebView page.
func (b *ChordBridge) SendFrame(ctx context.Context, frame string) error {
	if len(frame) == 0 {
		return link.ErrInvalidFrame
	}
	return b.transport.PushInbound(ctx, []byte(frame))
}

// StreamFrames streams outbound Chord Link frames to the calling WebView page over
// a MyGo Channel until ctx is canceled or the transport closes.
func (b *ChordBridge) StreamFrames(ctx context.Context, frames *mygo.Channel[string]) error {
	if frames == nil {
		return errors.New("chord bridge: nil stream channel")
	}
	for {
		pkt, err := b.transport.PullOutbound(ctx)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		if err := frames.Send(string(pkt)); err != nil {
			if errors.Is(err, mygo.ErrChannelClosed) {
				return nil
			}
			return err
		}
	}
}

// Close closes the underlying transport.
func (b *ChordBridge) Close() error {
	return b.transport.Close()
}

type bridgePeerTransport struct {
	bridge *ChordBridge
}

func (p *bridgePeerTransport) Send(ctx context.Context, frame []byte) error {
	return p.bridge.SendFrame(ctx, string(frame))
}

func (p *bridgePeerTransport) Recv(ctx context.Context) ([]byte, error) {
	return p.bridge.transport.PullOutbound(ctx)
}

func (p *bridgePeerTransport) Close() error {
	return p.bridge.Close()
}

// ChordLinkService exposes only JSON-bindable MyGo RPC methods for WebView pages.
type ChordLinkService struct {
	bridge *ChordBridge
}

// Ping reports bridge readiness to WebView callers.
func (s *ChordLinkService) Ping(ctx context.Context) string {
	return s.bridge.Ping(ctx)
}

// SendFrame accepts a serialized Chord Link frame from the WebView page.
func (s *ChordLinkService) SendFrame(ctx context.Context, frame string) error {
	return s.bridge.SendFrame(ctx, frame)
}

// StreamFrames streams outbound Chord Link frames to the calling WebView page over
// a MyGo Channel until ctx is canceled or the transport closes.
func (s *ChordLinkService) StreamFrames(ctx context.Context, frames *mygo.Channel[string]) error {
	return s.bridge.StreamFrames(ctx, frames)
}

// Service returns the MyGo-bindable RPC facade for ChordLink.
func (b *ChordBridge) Service() *ChordLinkService {
	return &ChordLinkService{bridge: b}
}

// RegisterChordBridge binds b once per process under the MyGo service name "ChordLink".
func RegisterChordBridge(b *ChordBridge) (err error) {
	if b == nil {
		return errors.New("chord bridge: nil bridge")
	}
	bindBridgeOnce.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				bindBridgeErr = errors.New("chord bridge: bind failed")
			}
		}()
		mygo.BindAs("ChordLink", b.Service())
	})
	return bindBridgeErr
}

// ChordBridgePreloadScript installs a lightweight Chord Link frame transport shim on
// window.__vibevalleyChordTransport backed by window.mygo without touching TCP sockets.
func ChordBridgePreloadScript() string {
	return `(function(){
  if (window.__vibevalleyChordTransport) return;
  window.__vibevalleyChordTransport = {
    open: function(onFrame, onClose) {
      if (!window.mygo || typeof window.mygo.channel !== "function") {
        throw new Error("mygo bridge unavailable");
      }
      var ch = window.mygo.channel(function(raw) {
        if (onFrame) onFrame(raw);
      });
      ch.onclose = function() {
        if (onClose) onClose();
      };
      var streamPromise = window.mygo.call("ChordLink.StreamFrames", ch);
      streamPromise.catch(function() { if (onClose) onClose(); });
      return {
        send: function(frame) {
          var payload = typeof frame === "string" ? frame : JSON.stringify(frame);
          return window.mygo.call("ChordLink.SendFrame", payload);
        },
        close: function() {
          ch.close();
        }
      };
    }
  };
})();`
}
