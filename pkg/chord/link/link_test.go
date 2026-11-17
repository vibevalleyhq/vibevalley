package link_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
)

func testPrincipal(kind link.PrincipalKind, id string, caps ...string) link.Principal {
	return link.Principal{
		Kind:         kind,
		ID:           id,
		SessionID:    "sess-" + id,
		Capabilities: caps,
		ExpiresAtMs:  time.Now().Add(time.Hour).UnixMilli(),
	}
}

func startPipePair(t *testing.T, clientOpts, serverOpts link.Options) (*link.Link, *link.Link) {
	t.Helper()
	trA, trB := link.NewMemoryPipe()
	lA := link.NewLink(trA, clientOpts)
	lB := link.NewLink(trB, serverOpts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	errCh := make(chan error, 2)
	go func() { errCh <- lA.Start(ctx) }()
	go func() { errCh <- lB.Start(ctx) }()
	for range 2 {
		if err := <-errCh; err != nil {
			_ = lA.Close()
			_ = lB.Close()
			t.Fatalf("Start failed: %v", err)
		}
	}
	return lA, lB
}

func TestHandshakePrincipalValidation(t *testing.T) {
	t.Run("valid principal binds peer identity and context", func(t *testing.T) {
		pClient := testPrincipal(link.PrincipalMachineNode, "m1", "exec", "fs.write")
		pServer := testPrincipal(link.PrincipalUserDevice, "server-1", "control")

		trA, trB := link.NewMemoryPipe()
		lA := link.NewLink(trA, link.Options{Principal: pClient})
		lB := link.NewLink(trB, link.Options{Principal: pServer})

		lB.HandleRPC("whoami", func(ctx context.Context, _ json.RawMessage) (any, error) {
			p, ok := link.PrincipalFromContext(ctx)
			if !ok {
				return nil, errors.New("missing principal in rpc ctx")
			}
			return p, nil
		})

		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		errCh := make(chan error, 2)
		go func() { errCh <- lA.Start(ctx) }()
		go func() { errCh <- lB.Start(ctx) }()
		for range 2 {
			if err := <-errCh; err != nil {
				t.Fatalf("Start: %v", err)
			}
		}
		defer func() {
			_ = lA.Close()
			_ = lB.Close()
			lA.Wait()
			lB.Wait()
		}()

		if got := lB.PeerPrincipal(); got.ID != "m1" || got.Kind != link.PrincipalMachineNode || !got.HasCapability("fs.write") {
			t.Fatalf("unexpected peer principal: %#v", got)
		}

		var echoed link.Principal
		if err := lA.Call(ctx, "whoami", nil, &echoed); err != nil {
			t.Fatalf("Call whoami: %v", err)
		}
		if echoed.ID != "m1" || echoed.SessionID != "sess-m1" {
			t.Fatalf("unexpected echoed principal: %#v", echoed)
		}
	})

	t.Run("expired principal rejected during handshake", func(t *testing.T) {
		trA, trB := link.NewMemoryPipe()
		expired := link.Principal{
			Kind:        link.PrincipalSessionToken,
			ID:          "tok-old",
			ExpiresAtMs: time.Now().Add(-time.Minute).UnixMilli(),
		}
		valid := testPrincipal(link.PrincipalUserDevice, "srv")
		lA := link.NewLink(trA, link.Options{Principal: expired})
		lB := link.NewLink(trB, link.Options{Principal: valid})

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		errCh := make(chan error, 2)
		go func() { errCh <- lA.Start(ctx) }()
		go func() { errCh <- lB.Start(ctx) }()

		err1 := <-errCh
		err2 := <-errCh
		if err1 == nil || err2 == nil {
			t.Fatalf("expected handshake errors on both sides, got err1=%v err2=%v", err1, err2)
		}
		_ = lA.Close()
		_ = lB.Close()
		lA.Wait()
		lB.Wait()
	})
}

func TestBidirectionalRPCWithDeadlinesAndCancel(t *testing.T) {
	trA, trB := link.NewMemoryPipe()
	lA := link.NewLink(trA, link.Options{Principal: testPrincipal(link.PrincipalUserDevice, "a")})
	lB := link.NewLink(trB, link.Options{Principal: testPrincipal(link.PrincipalMachineNode, "b")})

	canceledOnB := make(chan struct{})
	deadlineOnA := make(chan struct{})

	lA.HandleRPC("slowA", func(ctx context.Context, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		close(deadlineOnA)
		return nil, ctx.Err()
	})
	lB.HandleRPC("slowB", func(ctx context.Context, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		close(canceledOnB)
		return nil, ctx.Err()
	})
	lA.HandleRPC("echoA", func(_ context.Context, params json.RawMessage) (any, error) {
		return map[string]any{"from": "A", "in": json.RawMessage(params)}, nil
	})
	lB.HandleRPC("echoB", func(_ context.Context, params json.RawMessage) (any, error) {
		return map[string]any{"from": "B", "in": json.RawMessage(params)}, nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	errCh := make(chan error, 2)
	go func() { errCh <- lA.Start(ctx) }()
	go func() { errCh <- lB.Start(ctx) }()
	for range 2 {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_ = lA.Close()
		_ = lB.Close()
		lA.Wait()
		lB.Wait()
	}()

	var resA, resB map[string]any
	if err := lA.Call(ctx, "echoB", map[string]any{"n": 1}, &resB); err != nil {
		t.Fatalf("lA.Call echoB: %v", err)
	}
	if err := lB.Call(ctx, "echoA", map[string]any{"n": 2}, &resA); err != nil {
		t.Fatalf("lB.Call echoA: %v", err)
	}
	if resB["from"] != "B" || resA["from"] != "A" {
		t.Fatalf("unexpected bidirectional results: resA=%v resB=%v", resA, resB)
	}

	// Explicit cancellation propagates via rpc_cancel.
	cCtx, cCancel := context.WithCancel(ctx)
	go func() {
		time.Sleep(20 * time.Millisecond)
		cCancel()
	}()
	if err := lA.Call(cCtx, "slowB", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	select {
	case <-canceledOnB:
	case <-time.After(time.Second):
		t.Fatal("rpc_cancel did not cancel handler on B")
	}

	// Deadline propagates and cancels handler on A.
	dCtx, dCancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer dCancel()
	if err := lB.Call(dCtx, "slowA", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
	select {
	case <-deadlineOnA:
	case <-time.After(time.Second):
		t.Fatal("deadline did not cancel handler on A")
	}
}

type inspectingTransport struct {
	inner     link.FrameTransport
	onSend    func(frame []byte)
	sendDelay time.Duration
}

func (t *inspectingTransport) Send(ctx context.Context, frame []byte) error {
	if t.onSend != nil {
		t.onSend(frame)
	}
	if t.sendDelay > 0 {
		select {
		case <-time.After(t.sendDelay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return t.inner.Send(ctx, frame)
}

func (t *inspectingTransport) Recv(ctx context.Context) ([]byte, error) {
	return t.inner.Recv(ctx)
}

func (t *inspectingTransport) Close() error {
	return t.inner.Close()
}

func TestChunkingAvoidsHeadOfLineBlocking(t *testing.T) {
	rawA, rawB := link.NewMemoryPipe(128)

	var maxWireSeen atomic.Int64
	var chunkCount atomic.Int64
	trA := &inspectingTransport{
		inner:     rawA,
		sendDelay: 2 * time.Millisecond,
		onSend: func(frame []byte) {
			n := int64(len(frame))
			for {
				prev := maxWireSeen.Load()
				if n <= prev || maxWireSeen.CompareAndSwap(prev, n) {
					break
				}
			}
			var f link.Frame
			if json.Unmarshal(frame, &f) == nil && f.Kind == link.FrameChunk {
				chunkCount.Add(1)
			}
		},
	}

	lA := link.NewLink(trA, link.Options{Principal: testPrincipal(link.PrincipalUserDevice, "a")})
	lB := link.NewLink(rawB, link.Options{Principal: testPrincipal(link.PrincipalMachineNode, "b")})

	lB.HandleRPC("upload", func(_ context.Context, params json.RawMessage) (any, error) {
		var payload struct {
			Blob string `json:"blob"`
		}
		if err := json.Unmarshal(params, &payload); err != nil {
			return nil, err
		}
		return map[string]any{"bytes": len(payload.Blob)}, nil
	})
	lB.HandleRPC("fastPing", func(_ context.Context, _ json.RawMessage) (any, error) {
		return map[string]any{"pong": true}, nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	errCh := make(chan error, 2)
	go func() { errCh <- lA.Start(ctx) }()
	go func() { errCh <- lB.Start(ctx) }()
	for range 2 {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_ = lA.Close()
		_ = lB.Close()
		lA.Wait()
		lB.Wait()
	}()

	// 512 KB payload must split into >64KB-bounded chunks.
	bigBlob := strings.Repeat("Z", 512*1024)
	bigDone := make(chan int64, 1)
	go func() {
		var out struct {
			Bytes int `json:"bytes"`
		}
		if err := lA.Call(ctx, "upload", map[string]any{"blob": bigBlob}, &out); err != nil {
			t.Errorf("upload Call failed: %v", err)
			bigDone <- 0
			return
		}
		if out.Bytes != len(bigBlob) {
			t.Errorf("upload len mismatch: got %d want %d", out.Bytes, len(bigBlob))
		}
		bigDone <- time.Now().UnixNano()
	}()

	// Wait until chunking has visibly begun, then fire a small RPC and verify it
	// completes BEFORE the big upload finishes (no HoL blocking).
	for chunkCount.Load() < 1 {
		time.Sleep(time.Millisecond)
	}
	var pingRes map[string]any
	if err := lA.Call(ctx, "fastPing", nil, &pingRes); err != nil {
		t.Fatalf("fastPing failed: %v", err)
	}
	fastFinished := time.Now().UnixNano()
	bigFinished := <-bigDone

	if fastFinished >= bigFinished {
		t.Fatalf("fastPing was head-of-line blocked behind 512KB upload: fast=%d big=%d", fastFinished, bigFinished)
	}
	if maxWireSeen.Load() > link.MaxFrameBytes {
		t.Fatalf("wire frame exceeded 64KB cap: %d > %d", maxWireSeen.Load(), link.MaxFrameBytes)
	}
	if chunkCount.Load() < 8 {
		t.Fatalf("expected >= 8 chunks for 512KB payload, got %d", chunkCount.Load())
	}
}

type silentRecvTransport struct {
	in     chan []byte
	closed chan struct{}
	once   sync.Once
}

func (s *silentRecvTransport) Send(_ context.Context, _ []byte) error {
	select {
	case <-s.closed:
		return link.ErrTransportClosed
	default:
		return nil
	}
}

func (s *silentRecvTransport) Recv(ctx context.Context) ([]byte, error) {
	select {
	case b := <-s.in:
		return b, nil
	case <-s.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *silentRecvTransport) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func TestHeartbeatTimeoutCancelsInFlightRPCs(t *testing.T) {
	if link.DefaultHeartbeatInterval != 15*time.Second || link.DefaultHeartbeatTimeout != 45*time.Second {
		t.Fatalf("unexpected heartbeat defaults: interval=%v timeout=%v", link.DefaultHeartbeatInterval, link.DefaultHeartbeatTimeout)
	}

	tr := &silentRecvTransport{
		in:     make(chan []byte, 4),
		closed: make(chan struct{}),
	}
	peer := testPrincipal(link.PrincipalMachineNode, "peer-1")
	helloRaw, _ := json.Marshal(link.Frame{Kind: link.FrameHello, Principal: &peer})
	ackRaw, _ := json.Marshal(link.Frame{Kind: link.FrameHelloAck})
	tr.in <- helloRaw
	tr.in <- ackRaw

	l := link.NewLink(tr, link.Options{
		Principal:         testPrincipal(link.PrincipalUserDevice, "client-1"),
		HeartbeatInterval: 15 * time.Millisecond,
		HeartbeatTimeout:  45 * time.Millisecond,
	})
	if err := l.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		_ = l.Close()
		l.Wait()
	}()

	// Queue an incoming RPC from the peer, then let the peer go silent so heartbeat times out.
	inHandlerCanceled := make(chan struct{})
	l.HandleRPC("hang", func(ctx context.Context, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		close(inHandlerCanceled)
		return nil, ctx.Err()
	})
	reqRaw, _ := json.Marshal(link.Frame{Kind: link.FrameRPCReq, ID: "peer-req-1", Method: "hang"})
	tr.in <- reqRaw

	const numOutbound = 5
	outErrs := make(chan error, numOutbound)
	for range numOutbound {
		go func() {
			outErrs <- l.Call(context.Background(), "remoteWork", nil, nil)
		}()
	}

	select {
	case <-inHandlerCanceled:
	case <-time.After(time.Second):
		t.Fatal("inbound RPC handler ctx was not canceled on heartbeat timeout")
	}

	for range numOutbound {
		select {
		case err := <-outErrs:
			if !errors.Is(err, link.ErrHeartbeatTimeout) {
				t.Fatalf("expected ErrHeartbeatTimeout, got %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("outbound RPC did not fail on heartbeat timeout")
		}
	}
	l.Wait()
}

func TestWebSocketRFC6455TransportAndFragmentation(t *testing.T) {
	accepted := make(chan *link.WebSocketTransport, 1)
	srv := httptest.NewServer(link.WebSocketHandler(func(tr *link.WebSocketTransport, r *http.Request) {
		if r.Header.Get("X-Machine-Token") != "secret-tok" {
			_ = tr.Close()
			return
		}
		accepted <- tr
	}, link.WithWebSocketSubprotocols("chord.v1")))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	clientTr, resp, err := link.DialWebSocket(ctx, wsURL,
		link.WithWebSocketHeaders(http.Header{"X-Machine-Token": []string{"secret-tok"}}),
		link.WithWebSocketSubprotocols("chord.v1"),
	)
	if err != nil {
		t.Fatalf("DialWebSocket: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols || clientTr.Subprotocol() != "chord.v1" {
		t.Fatalf("unexpected handshake response: status=%d proto=%q", resp.StatusCode, clientTr.Subprotocol())
	}
	serverTr := <-accepted

	defer func() {
		_ = clientTr.Close()
		_ = serverTr.Close()
	}()

	// Verify >126B and >64KB frames over WebSocket.
	large := bytes.Repeat([]byte("A"), 90*1024)
	go func() {
		_ = clientTr.Send(ctx, large)
	}()
	got, err := serverTr.Recv(ctx)
	if err != nil {
		t.Fatalf("server Recv large: %v", err)
	}
	if !bytes.Equal(got, large) {
		t.Fatalf("WebSocket payload mismatch: len got=%d want=%d", len(got), len(large))
	}

	// Verify RFC 6455 fragmented frames + interleaved Ping frame from a raw TCP client.
	rawSrv := httptest.NewServer(link.WebSocketHandler(func(tr *link.WebSocketTransport, _ *http.Request) {
		defer tr.Close()
		msg, err := tr.Recv(context.Background())
		if err != nil {
			t.Errorf("server Recv fragmented: %v", err)
			return
		}
		_ = tr.Send(context.Background(), msg)
	}))
	defer rawSrv.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(rawSrv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	var key [16]byte
	_, _ = rand.Read(key[:])
	b64Key := base64.StdEncoding.EncodeToString(key[:])
	_, _ = fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", b64Key)
	br := bufio.NewReader(conn)
	httpResp, err := http.ReadResponse(br, nil)
	if err != nil || httpResp.StatusCode != 101 {
		t.Fatalf("raw upgrade failed: %v %v", httpResp, err)
	}
	sum := sha1.Sum([]byte(b64Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if httpResp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		t.Fatal("Sec-WebSocket-Accept mismatch")
	}

	writeMasked := func(b0 byte, payload []byte) {
		mask := [4]byte{0x12, 0x34, 0x56, 0x78}
		hdr := []byte{b0, 0x80 | byte(len(payload)), mask[0], mask[1], mask[2], mask[3]}
		out := append(hdr, payload...)
		for i := range payload {
			out[6+i] ^= mask[i&3]
		}
		_, _ = conn.Write(out)
	}

	// Fragment 1 (FIN=0, opcode=0x1 "hello "), interleaved Ping (FIN=1, opcode=0x9 "ping"), Fragment 2 (FIN=1, opcode=0x0 "world").
	writeMasked(0x01, []byte("hello "))
	writeMasked(0x89, []byte("ping"))
	writeMasked(0x80, []byte("world"))

	// Should receive Pong ("ping") AND echoed Text ("hello world").
	gotPong := false
	gotText := false
	for !gotPong || !gotText {
		var h [2]byte
		if _, err := io.ReadFull(br, h[:]); err != nil {
			t.Fatalf("read response frame: %v", err)
		}
		op := h[0] & 0x0F
		n := int(h[1] & 0x7F)
		p := make([]byte, n)
		if _, err := io.ReadFull(br, p); err != nil {
			t.Fatalf("read payload: %v", err)
		}
		switch op {
		case 0xA:
			if string(p) != "ping" {
				t.Fatalf("unexpected pong payload %q", p)
			}
			gotPong = true
		case 0x1:
			if string(p) != "hello world" {
				t.Fatalf("unexpected reassembled text %q", p)
			}
			gotText = true
		default:
			t.Fatalf("unexpected opcode 0x%x", op)
		}
	}
}

func TestStress1000RPCs200WatchesRaceAndLeakFree(t *testing.T) {
	// Warm up stdlib HTTP/test server before capturing baseline goroutine count.
	srvLinks := make(chan *link.Link, 1)
	srv := httptest.NewServer(link.WebSocketHandler(func(tr *link.WebSocketTransport, _ *http.Request) {
		l := link.NewLink(tr, link.Options{
			Principal:         testPrincipal(link.PrincipalUserDevice, "server"),
			HeartbeatInterval: 200 * time.Millisecond,
			HeartbeatTimeout:  600 * time.Millisecond,
		})
		srvLinks <- l
	}))
	defer srv.Close()

	// Allow httptest listener goroutine to settle before recording baseline.
	time.Sleep(10 * time.Millisecond)
	baseGoroutines := runtime.NumGoroutine()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	clientTr, _, err := link.DialWebSocket(ctx, wsURL)
	if err != nil {
		t.Fatalf("DialWebSocket: %v", err)
	}
	serverTrLink := <-srvLinks

	clientLink := link.NewLink(clientTr, link.Options{
		Principal:         testPrincipal(link.PrincipalMachineNode, "client"),
		HeartbeatInterval: 200 * time.Millisecond,
		HeartbeatTimeout:  600 * time.Millisecond,
	})

	// Register 200 observable documents and bidirectional RPC handlers.
	docs := make([]*watch.Document[map[string]any], 200)
	for i := range 200 {
		doc, err := watch.NewDocument(map[string]any{"idx": int64(i), "text": "init"})
		if err != nil {
			t.Fatal(err)
		}
		docs[i] = doc
		serverTrLink.PublishDocument(fmt.Sprintf("doc/%d", i), doc)
	}

	serverTrLink.HandleRPC("compute", func(rpcCtx context.Context, params json.RawMessage) (any, error) {
		var req struct {
			ID    int  `json:"id"`
			Delay bool `json:"delay"`
		}
		_ = json.Unmarshal(params, &req)
		if req.Delay {
			select {
			case <-time.After(150 * time.Millisecond):
			case <-rpcCtx.Done():
				return nil, rpcCtx.Err()
			}
		}
		return map[string]any{"ok": true, "id": req.ID}, nil
	})
	clientLink.HandleRPC("clientEcho", func(_ context.Context, params json.RawMessage) (any, error) {
		return params, nil
	})

	errCh := make(chan error, 2)
	go func() { errCh <- clientLink.Start(ctx) }()
	go func() { errCh <- serverTrLink.Start(ctx) }()
	for range 2 {
		if err := <-errCh; err != nil {
			t.Fatalf("Start: %v", err)
		}
	}

	// Open 200 concurrent Watches.
	subs := make([]*link.WatchSubscription, 200)
	for i := range 200 {
		wCtx, wCancel := context.WithCancel(ctx)
		if i%5 == 0 {
			go func(c context.CancelFunc) {
				time.Sleep(15 * time.Millisecond)
				c()
			}(wCancel)
		} else {
			defer wCancel()
		}
		sub, err := clientLink.OpenWatch(wCtx, fmt.Sprintf("doc/%d", i), 0, nil, func(_ context.Context, _ link.WatchEvent) {}, nil)
		if err != nil {
			t.Fatalf("OpenWatch %d: %v", i, err)
		}
		subs[i] = sub
	}

	// Drive mutations on the 200 docs while launching 1,000 concurrent bidirectional RPCs.
	var rpcWG sync.WaitGroup
	for i := range 1000 {
		rpcWG.Add(1)
		go func(n int) {
			defer rpcWG.Done()
			rCtx, rCancel := context.WithTimeout(ctx, 2*time.Second)
			defer rCancel()
			if n%7 == 0 {
				go func() {
					time.Sleep(time.Duration(1+n%10) * time.Millisecond)
					rCancel()
				}()
			}
			if n%2 == 0 {
				_ = clientLink.Call(rCtx, "compute", map[string]any{"id": n, "delay": n%10 == 0}, nil)
			} else {
				_ = serverTrLink.Call(rCtx, "clientEcho", map[string]any{"id": n}, nil)
			}
		}(i)
	}

	for i := range 200 {
		_, _ = docs[i].Mutate(func(d *delta.Draft) error {
			return d.AppendText([]string{"text"}, "_up")
		})
	}

	// Inject abrupt link close mid-flight while remaining RPCs/Watches are running.
	time.Sleep(25 * time.Millisecond)
	_ = clientLink.Close()
	_ = serverTrLink.Close()
	clientLink.Wait()
	serverTrLink.Wait()
	rpcWG.Wait()

	for _, sub := range subs {
		sub.Stop()
	}

	// Verify all spawned goroutines exit cleanly within 100ms after closing.
	deadline := time.Now().Add(100 * time.Millisecond)
	for runtime.NumGoroutine() > baseGoroutines && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	if got := runtime.NumGoroutine(); got > baseGoroutines {
		t.Fatalf("goroutine leak after 100ms: baseline=%d current=%d", baseGoroutines, got)
	}
}

func TestReconnectParityWebSocketAndMemoryPipe(t *testing.T) {
	type transportFactory struct {
		name  string
		setup func(t *testing.T, serverOpts link.Options, docs map[string]watch.RawSource) (dial link.DialFunc, dropActive func(), cleanup func())
	}

	factories := []transportFactory{
		{
			name: "memory_pipe",
			setup: func(t *testing.T, serverOpts link.Options, docs map[string]watch.RawSource) (link.DialFunc, func(), func()) {
				var mu sync.Mutex
				var activeServer *link.Link

				dial := func(ctx context.Context) (link.FrameTransport, error) {
					cTr, sTr := link.NewMemoryPipe()
					sLink := link.NewLink(sTr, serverOpts)
					for target, src := range docs {
						sLink.PublishDocument(target, src)
					}
					go func() {
						if err := sLink.Start(context.Background()); err != nil {
							_ = sTr.Close()
						}
					}()
					mu.Lock()
					activeServer = sLink
					mu.Unlock()
					return cTr, nil
				}
				dropActive := func() {
					mu.Lock()
					s := activeServer
					mu.Unlock()
					if s != nil {
						_ = s.Close()
						s.Wait()
					}
				}
				cleanup := func() {
					dropActive()
				}
				return dial, dropActive, cleanup
			},
		},
		{
			name: "websocket",
			setup: func(t *testing.T, serverOpts link.Options, docs map[string]watch.RawSource) (link.DialFunc, func(), func()) {
				var mu sync.Mutex
				var activeServer *link.Link

				srv := httptest.NewServer(link.WebSocketHandler(func(tr *link.WebSocketTransport, _ *http.Request) {
					sLink := link.NewLink(tr, serverOpts)
					for target, src := range docs {
						sLink.PublishDocument(target, src)
					}
					if err := sLink.Start(context.Background()); err != nil {
						_ = tr.Close()
						return
					}
					mu.Lock()
					activeServer = sLink
					mu.Unlock()
				}))
				wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
				dial := func(ctx context.Context) (link.FrameTransport, error) {
					tr, _, err := link.DialWebSocket(ctx, wsURL)
					return tr, err
				}
				dropActive := func() {
					mu.Lock()
					s := activeServer
					mu.Unlock()
					if s != nil {
						_ = s.Close()
						s.Wait()
					}
				}
				cleanup := func() {
					dropActive()
					srv.Close()
				}
				return dial, dropActive, cleanup
			},
		},
	}

	for _, tf := range factories {
		t.Run(tf.name, func(t *testing.T) {
			doc, err := watch.NewDocument(map[string]any{
				"stream": "start",
				"count":  int64(0),
			}, watch.WithHistorySize[map[string]any](10))
			if err != nil {
				t.Fatal(err)
			}

			serverOpts := link.Options{
				Principal:         testPrincipal(link.PrincipalUserDevice, "server"),
				HeartbeatInterval: 200 * time.Millisecond,
				HeartbeatTimeout:  600 * time.Millisecond,
			}
			dial, dropActive, cleanup := tf.setup(t, serverOpts, map[string]watch.RawSource{
				"space/core": doc,
			})
			defer cleanup()

			disconnected := make(chan struct{}, 8)
			reconnected := make(chan struct{}, 8)
			client := link.NewClient(dial, link.ClientOptions{
				LinkOptions: link.Options{
					Principal:         testPrincipal(link.PrincipalMachineNode, "client"),
					HeartbeatInterval: 200 * time.Millisecond,
					HeartbeatTimeout:  600 * time.Millisecond,
				},
				ReconnectMinDelay: 10 * time.Millisecond,
				ReconnectMaxDelay: 30 * time.Millisecond,
				OnDisconnect: func(_ error) {
					select {
					case disconnected <- struct{}{}:
					default:
					}
				},
				OnConnect: func(_ *link.Link) {
					select {
					case reconnected <- struct{}{}:
					default:
					}
				},
			})

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := client.Connect(ctx); err != nil {
				t.Fatalf("Connect: %v", err)
			}
			defer client.Close()
			// Drain initial OnConnect signal.
			<-reconnected

			events := make(chan link.WatchEvent, 32)
			cw, err := client.Watch(ctx, "space/core", func(_ context.Context, ev link.WatchEvent) {
				events <- ev
			})
			if err != nil {
				t.Fatalf("Watch: %v", err)
			}
			defer cw.Stop()

			ev := <-events
			if ev.Rev != 1 || ev.Snapshot.Value().(map[string]any)["stream"] != "start" {
				t.Fatalf("unexpected initial event: %#v", ev)
			}

			// 1) Incremental catchup within ring buffer across disconnect.
			dropActive()
			<-disconnected

			for i := int64(1); i <= 3; i++ {
				if _, err := doc.Mutate(func(d *delta.Draft) error {
					if err := d.AppendText([]string{"stream"}, fmt.Sprintf("+%d", i)); err != nil {
						return err
					}
					return d.Set([]string{"count"}, i)
				}); err != nil {
					t.Fatal(err)
				}
			}

			select {
			case <-reconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for reconnect 1")
			}

			ev = <-events
			if ev.Rev != 4 || ev.Retired {
				t.Fatalf("expected rev 4 after incremental reconnect, got %#v", ev)
			}
			for _, op := range ev.Ops {
				if op.Kind == delta.OpReplace && len(op.Path) == 0 {
					t.Fatalf("expected incremental delta within ring buffer, got root replace: %#v", ev.Ops)
				}
			}
			if !delta.Equal(ev.Snapshot.Value(), map[string]any{"stream": "start+1+2+3", "count": int64(3)}) {
				t.Fatalf("unexpected caught-up state: %#v", ev.Snapshot.Value())
			}

			// 2) Fallback root replace when offline commits exceed ring buffer (cap=10).
			dropActive()
			<-disconnected

			for i := int64(4); i <= 25; i++ {
				if _, err := doc.Mutate(func(d *delta.Draft) error {
					return d.Set([]string{"count"}, i)
				}); err != nil {
					t.Fatal(err)
				}
			}

			select {
			case <-reconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for reconnect 2")
			}

			ev = <-events
			if ev.Rev != 26 || len(ev.Ops) != 1 || ev.Ops[0].Kind != delta.OpReplace || len(ev.Ops[0].Path) != 0 {
				t.Fatalf("expected fallback root replace at rev 26, got %#v", ev)
			}
			_, serverSnap, _ := doc.Snapshot()
			if !delta.Equal(ev.Snapshot.Value(), serverSnap.Value()) {
				t.Fatalf("client snapshot diverged after fallback root replace: got=%#v want=%#v", ev.Snapshot.Value(), serverSnap.Value())
			}

			// 3) Retire and Rebuild continuity across disconnect.
			dropActive()
			<-disconnected
			doc.Retire()

			select {
			case <-reconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for reconnect 3")
			}

			ev = <-events
			if !ev.Retired || len(ev.Ops) != 0 || !delta.Equal(ev.Snapshot.Value(), serverSnap.Value()) {
				t.Fatalf("expected retired=true preserving last snapshot, got %#v", ev)
			}

			if _, err := doc.Rebuild(map[string]any{"stream": "rebuilt", "count": int64(100)}); err != nil {
				t.Fatal(err)
			}
			ev = <-events
			if ev.Retired || ev.Rev != 27 || !delta.Equal(ev.Snapshot.Value(), map[string]any{"stream": "rebuilt", "count": int64(100)}) {
				t.Fatalf("expected seamless rebuild after retire, got %#v", ev)
			}
		})
	}
}

func TestLinkChunkedWatchPushOver64KBAndMissingTarget(t *testing.T) {
	rawA, rawB := link.NewMemoryPipe(64)
	var maxWire atomic.Int64
	trA := &inspectingTransport{
		inner: rawA,
		onSend: func(frame []byte) {
			n := int64(len(frame))
			for {
				prev := maxWire.Load()
				if n <= prev || maxWire.CompareAndSwap(prev, n) {
					break
				}
			}
		},
	}

	lServer := link.NewLink(trA, link.Options{Principal: testPrincipal(link.PrincipalUserDevice, "srv")})
	lClient := link.NewLink(rawB, link.Options{Principal: testPrincipal(link.PrincipalMachineNode, "cli")})

	bigDoc, err := watch.NewDocument(map[string]any{
		"payload": strings.Repeat("B", 150*1024),
	})
	if err != nil {
		t.Fatal(err)
	}
	lServer.PublishDocument("big/doc", bigDoc)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	errCh := make(chan error, 2)
	go func() { errCh <- lServer.Start(ctx) }()
	go func() { errCh <- lClient.Start(ctx) }()
	for range 2 {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		_ = lServer.Close()
		_ = lClient.Close()
		lServer.Wait()
		lClient.Wait()
	}()

	gotBig := make(chan link.WatchEvent, 1)
	sub, err := lClient.OpenWatch(ctx, "big/doc", 0, nil, func(_ context.Context, ev link.WatchEvent) {
		gotBig <- ev
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Stop()

	ev := <-gotBig
	if len(ev.Snapshot.Value().(map[string]any)["payload"].(string)) != 150*1024 {
		t.Fatal("chunked watch snapshot payload truncated")
	}
	if maxWire.Load() > link.MaxFrameBytes {
		t.Fatalf("watch_push exceeded 64KB wire limit: %d", maxWire.Load())
	}

	endErrCh := make(chan error, 1)
	_, err = lClient.OpenWatch(ctx, "does/not/exist", 0, nil, nil, func(err error) {
		endErrCh <- err
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case endErr := <-endErrCh:
		var rpcErr *link.RPCError
		if !errors.As(endErr, &rpcErr) || rpcErr.Code != "not_found" {
			t.Fatalf("expected not_found RPCError on watch_end, got %v", endErr)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for watch_end on missing target")
	}
}
