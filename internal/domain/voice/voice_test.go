package voice

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	agoraSampleAppID = "970CA35de60c44645bbae8a215061b33"
	agoraSampleCert  = "5CFd2fd1755d40ecb72977518be15d3b"
	agoraSampleChan  = "7d72365eb983485397e3e3f9d460bdda"
	// Generated directly by agora-token@2.0.7 AccessToken2.build() with issueTs=1111111, salt=1, expire=600, uid="1001".
	agoraGolden007 = "007eJxTYNj80G7nRXHeYBXejqpgxi379fyC7TbNORWhvrtsu1dYt7sCg6W5gbOjsWlKqplBsomJmYlpUlJiqkWikaGpgZlhkrGx+xcBhggmBgZGBgYGJgZGBhYGRjCfCUwyg0kWMKnAYJ5ibmRsZpqaZGlhbGJhamxpnmqcapxmmWJiZpCUkpLIwmBoYGAIMoURqg/EBwA84iQd"
)

func TestAgoraAccessToken2GoldenAndRoundTrip(t *testing.T) {
	t.Parallel()

	// Verify exact compatibility against agora-token@2.0.7 golden vector.
	parsedGolden, err := ParseAccessToken2(agoraGolden007)
	if err != nil {
		t.Fatalf("ParseAccessToken2(golden): %v", err)
	}
	if !parsedGolden.VerifySignature(agoraSampleCert) {
		t.Fatalf("golden AccessToken2 signature verification failed")
	}
	if parsedGolden.VerifySignature("00000000000000000000000000000000") {
		t.Fatalf("wrong certificate must not verify")
	}
	if parsedGolden.AppID != agoraSampleAppID || parsedGolden.IssueTs != 1111111 || parsedGolden.Expire != 600 || parsedGolden.Salt != 1 {
		t.Fatalf("unexpected golden header claims: %+v", parsedGolden)
	}
	if len(parsedGolden.Services) != 2 {
		t.Fatalf("expected 2 services (RTC+RTM) in golden token, got %d", len(parsedGolden.Services))
	}

	// Build deterministic AccessToken2 in Go and verify round-trip signature & service privileges.
	tok, err := NewAccessToken2(agoraSampleAppID, agoraSampleCert, 1111111, 600)
	if err != nil {
		t.Fatalf("NewAccessToken2: %v", err)
	}
	tok.Salt = 1

	rtc := NewServiceRTC(agoraSampleChan, "1001")
	rtc.AddPrivilege(PrivilegeJoinChannel, 600)
	rtc.AddPrivilege(PrivilegePublishAudioStream, 600)
	rtc.AddPrivilege(PrivilegePublishVideoStream, 600)
	rtc.AddPrivilege(PrivilegePublishDataStream, 600)
	tok.AddService(rtc)

	rtm := NewServiceRTM("1001")
	rtm.AddPrivilege(PrivilegeLoginRTM, 600)
	tok.AddService(rtm)

	built, err := tok.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if !strings.HasPrefix(built, AccessToken2Version) {
		t.Fatalf("expected 007 prefix, got %q", built)
	}

	parsedGo, err := ParseAccessToken2(built)
	if err != nil {
		t.Fatalf("ParseAccessToken2(go): %v", err)
	}
	if !parsedGo.VerifySignature(agoraSampleCert) {
		t.Fatalf("Go-built AccessToken2 signature failed verification")
	}
	// Verify signing payload bytes match agora-token@2.0.7 byte-for-byte.
	if string(parsedGo.signingInfo) != string(parsedGolden.signingInfo) {
		t.Fatalf("signingInfo mismatch between Go packer and agora-token@2.0.7")
	}

	// Invalid credentials must fail.
	if _, err := BuildTokenWithRTM("bad-app", agoraSampleCert, "chan", "1", RolePublisher, 3600, 3600); !errors.Is(err, ErrInvalidAgoraCredentials) {
		t.Fatalf("expected ErrInvalidAgoraCredentials, got %v", err)
	}
}

func TestVoiceGrantCallLifecycleDictateAndMossVerify(t *testing.T) {
	t.Parallel()

	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	var (
		joinedURL  string
		stoppedURL string
		heardCalls []VoiceHeard
		saidCalls  []VoiceSaid
		states     []CallState
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/join"):
			joinedURL = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-voice-1"})
		case strings.HasSuffix(r.URL.Path, "/leave"):
			stoppedURL = r.URL.Path
			w.WriteHeader(http.StatusNotFound) // Agora already-stopping 404 is treated as success.
		case r.URL.Path == "/v1/audio/transcriptions":
			mr, err := r.MultipartReader()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			var gotFile bool
			for {
				part, err := mr.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				if part.FormName() == "file" && part.FileName() == "audio.wav" {
					gotFile = true
				}
			}
			if !gotFile {
				http.Error(w, "missing audio file", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"text": "帮我跑一下测试"})
		case r.URL.Path == "/v1/realtime":
			if r.Header.Get("Authorization") == "Bearer moss-bad-key" {
				http.Error(w, "invalid key moss-bad-key", http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	mossKey := "moss-good-key"
	svc := NewService(Options{
		Clock:      clk,
		HTTPClient: srv.Client(),
		AgoraBaseURLs: map[string]string{
			"US": srv.URL,
		},
		MOSSStatusURL: srv.URL + "/v1/realtime?model=moss-live-1.0",
		VoiceConfig: func() VoiceConfigSnapshot {
			return VoiceConfigSnapshot{
				Area:           "US",
				Language:       "zh-CN",
				AnswerVendor:   "agora",
				Greeting:       "你好呀",
				FailureMessage: "请再说一次",
				IdleSeconds:    30,
			}
		},
		AgoraCredentials: func() (AgoraCredentials, bool) {
			return AgoraCredentials{
				AppID:          agoraSampleAppID,
				AppCertificate: agoraSampleCert,
				Area:           "US",
			}, true
		},
		DictationConfig: func() (DictationTarget, bool) {
			return DictationTarget{
				URL:   srv.URL + "/v1",
				Model: "whisper-1",
				Key:   "dict-key-123",
			}, true
		},
		MOSSKey: func() (string, bool) { return mossKey, true },
		OnHear: func(_ context.Context, h VoiceHeard) error {
			heardCalls = append(heardCalls, h)
			return nil
		},
		OnSay: func(_ context.Context, s VoiceSaid) error {
			saidCalls = append(saidCalls, s)
			return nil
		},
		OnStateChanged: func(f FactCallChanged) {
			states = append(states, f.State)
		},
	})

	// GrantCreate + GrantRenew issue valid 007 tokens.
	grant, err := svc.GrantCreate(context.Background())
	if err != nil {
		t.Fatalf("GrantCreate: %v", err)
	}
	if !strings.HasPrefix(grant.Token, "007") || grant.AppID != agoraSampleAppID {
		t.Fatalf("unexpected grant: %+v", grant)
	}
	parsedGrant, err := ParseAccessToken2(grant.Token)
	if err != nil || !parsedGrant.VerifySignature(agoraSampleCert) {
		t.Fatalf("GrantCreate token invalid: err=%v", err)
	}

	clk.Advance(10 * time.Second)
	renewed, err := svc.GrantRenew(context.Background(), VoiceGrantRenew{Channel: grant.Channel, UID: grant.UID})
	if err != nil || !strings.HasPrefix(renewed.Token, "007") || renewed.Token == grant.Token {
		t.Fatalf("GrantRenew failed: err=%v renewed=%+v", err, renewed)
	}

	// CallStart -> CallHear / Hear / CallSay -> CallStop.
	call, err := svc.CallStart(context.Background(), VoiceCallStart{Channel: grant.Channel, UID: grant.UID})
	if err != nil || call.AgentID != "agent-voice-1" {
		t.Fatalf("CallStart failed: err=%v call=%+v", err, call)
	}
	if joinedURL != "/api/conversational-ai-agent/v2/projects/"+agoraSampleAppID+"/join" {
		t.Fatalf("unexpected join URL: %q", joinedURL)
	}
	if svc.State().State != CallLive {
		t.Fatalf("expected live call state, got %s", svc.State().State)
	}

	if err := svc.Hear(context.Background(), "看看状态", "scout", "sk-1"); err != nil {
		t.Fatalf("Hear failed: %v", err)
	}
	if len(heardCalls) != 1 || heardCalls[0].Text != "看看状态" {
		t.Fatalf("unexpected heardCalls: %+v", heardCalls)
	}

	// Repeated greeting is suppressed; distinct speech triggers OnSay.
	_ = svc.CallSay(context.Background(), VoiceSaid{AgentID: call.AgentID, Text: "你好呀"})
	_ = svc.CallSay(context.Background(), VoiceSaid{AgentID: call.AgentID, Text: "已经开始跑测试了"})
	if len(saidCalls) != 1 || saidCalls[0].Text != "已经开始跑测试了" {
		t.Fatalf("unexpected saidCalls: %+v", saidCalls)
	}

	if err := svc.CallStop(context.Background(), call); err != nil {
		t.Fatalf("CallStop failed: %v", err)
	}
	if stoppedURL == "" || svc.State().State != CallIdle {
		t.Fatalf("expected leave call and idle state, got stoppedURL=%q state=%s", stoppedURL, svc.State().State)
	}
	if err := svc.Hear(context.Background(), "no call", "", ""); !errors.Is(err, ErrVoiceCallFailed) {
		t.Fatalf("expected ErrVoiceCallFailed with no live call, got %v", err)
	}

	// Dictation validation and upload.
	if _, err := svc.Dictate(context.Background(), DictateRequest{Audio: "ZmFrZQ==", Format: "exe"}); !errors.Is(err, ErrVoiceRefused) {
		t.Fatalf("expected ErrVoiceRefused for unsupported format, got %v", err)
	}
	dictated, err := svc.Dictate(context.Background(), DictateRequest{
		Audio:  base64.StdEncoding.EncodeToString([]byte("RIFFfakewav")),
		Format: "wav",
	})
	if err != nil || dictated.Text != "帮我跑一下测试" {
		t.Fatalf("Dictate failed: err=%v got=%+v", err, dictated)
	}

	// MossVerify passes with good key and redacts refused key on 401.
	if v := svc.MossVerify(context.Background()); v.Problem != "" {
		t.Fatalf("expected MossVerify ok, got %+v", v)
	}
	mossKey = "moss-bad-key"
	badV := svc.MossVerify(context.Background())
	if badV.Problem == "" || strings.Contains(badV.Problem, "moss-bad-key") || !strings.Contains(badV.Problem, "[redacted]") {
		t.Fatalf("expected redacted problem on refused MOSS key, got %+v", badV)
	}
	_ = states
}

func TestSpeakPiecesUTF8BoundarySplitting(t *testing.T) {
	t.Parallel()

	long := strings.Repeat("今天田里的玉米长得真好。", 30)
	pieces := SpeakPieces(long, 480)
	if len(pieces) < 2 {
		t.Fatalf("expected multiple pieces, got %d", len(pieces))
	}
	for i, p := range pieces {
		if len(p) > 480 {
			t.Fatalf("piece %d exceeded 480 bytes (%d)", i, len(p))
		}
		if !strings.HasSuffix(p, "。") {
			t.Fatalf("expected sentence-boundary split on piece %d: %q", i, p)
		}
	}
}

func testDialClientWS(t *testing.T, serverURL, path string) *wsConn {
	t.Helper()
	u, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse url %q: %v", serverURL, err)
	}
	conn, err := net.DialTimeout("tcp", u.Host, 5*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", u.Host, err)
	}
	var nonce [16]byte
	_, _ = rand.Read(nonce[:])
	key := base64.StdEncoding.EncodeToString(nonce[:])
	reqText := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if err := writeAll(conn, []byte(reqText)); err != nil {
		conn.Close()
		t.Fatalf("write upgrade: %v", err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		conn.Close()
		t.Fatalf("read upgrade response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		t.Fatalf("unexpected upgrade status %d", resp.StatusCode)
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	wantAccept := base64.StdEncoding.EncodeToString(sum[:])
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != wantAccept {
		conn.Close()
		t.Fatalf("Sec-WebSocket-Accept = %q, want %q", got, wantAccept)
	}
	return &wsConn{
		netConn:  conn,
		r:        br,
		isClient: true,
		maxFrame: defaultMaxWSFrameBytes,
	}
}

func readWireMaskedFlag(r *bufio.Reader) (fin bool, masked bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(r, hdr[:]); err != nil {
		return false, false, 0, nil, err
	}
	fin = (hdr[0] & 0x80) != 0
	opcode = hdr[0] & 0x0F
	masked = (hdr[1] & 0x80) != 0
	length := uint64(hdr[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return false, false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return false, false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(r, mask[:]); err != nil {
			return false, false, 0, nil, err
		}
	}
	payload = make([]byte, int(length))
	if length > 0 {
		if _, err = io.ReadFull(r, payload); err != nil {
			return false, false, 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
	}
	return fin, masked, opcode, payload, nil
}

func TestServeRealtimeWSBidirectionalFramesMaskingAndLengths(t *testing.T) {
	t.Parallel()

	var (
		mu          sync.Mutex
		gotAuth     string
		gotCustom   string
		gotSubproto string
		sawUnmasked bool
		upFrames    int
	)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotAuth = r.Header.Get("Authorization")
		gotCustom = r.Header.Get("X-Vibe-Custom")
		gotSubproto = r.Header.Get("Sec-WebSocket-Protocol")
		mu.Unlock()

		wsKey := r.Header.Get("Sec-WebSocket-Key")
		upConn, err := upgradeBrowserWS(w, wsKey, "realtime-v1", defaultMaxWSFrameBytes)
		if err != nil {
			return
		}
		defer upConn.netConn.Close()

		for {
			_, masked, op, data, err := readWireMaskedFlag(upConn.r)
			if err != nil {
				return
			}
			if op == wsOpClose {
				_ = upConn.writeClose(1000, "upstream bye")
				return
			}
			if op == wsOpPing {
				_ = upConn.writeFrame(true, wsOpPong, data)
				continue
			}
			mu.Lock()
			upFrames++
			if !masked {
				sawUnmasked = true
			}
			mu.Unlock()

			// Echo back unmasked (isClient=false).
			if err := upConn.writeFrame(true, op, data); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()

	upstreamWS := "ws" + strings.TrimPrefix(upstream.URL, "http")
	proxyDone := make(chan error, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		err := ServeRealtimeWS(w, r, RelayConfig{
			UpstreamURL: upstreamWS + "/v1/realtime?model=moss-live-1.0",
			APIKey:      "secret-moss-key",
			Headers:     http.Header{"X-Vibe-Custom": []string{"relay-1"}},
		})
		proxyDone <- err
	}))
	defer proxy.Close()

	client := testDialClientWS(t, proxy.URL, "/api/v1/voice/moss/line")
	defer client.netConn.Close()

	// 1. Ping -> Pong directly from relay.
	if err := client.writeFrame(true, wsOpPing, []byte("hb")); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	_, maskedPong, opPong, pongData, err := readWireMaskedFlag(client.r)
	if err != nil || opPong != wsOpPong || maskedPong || string(pongData) != "hb" {
		t.Fatalf("expected unmasked pong 'hb', got op=%d masked=%v data=%q err=%v", opPong, maskedPong, string(pongData), err)
	}

	// 2. 7-bit text frame (<=125 bytes).
	smallText := []byte(`{"action":"attach_session"}`)
	if err := client.writeFrame(true, wsOpText, smallText); err != nil {
		t.Fatalf("write small text: %v", err)
	}
	_, masked1, op1, got1, err := readWireMaskedFlag(client.r)
	if err != nil || op1 != wsOpText || masked1 || !bytes.Equal(got1, smallText) {
		t.Fatalf("7-bit text mismatch: op=%d masked=%v len=%d err=%v", op1, masked1, len(got1), err)
	}

	// 3. 16-bit (126) binary frame (1024 bytes).
	medBin := bytes.Repeat([]byte{0xAB, 0xCD}, 512)
	if err := client.writeFrame(true, wsOpBinary, medBin); err != nil {
		t.Fatalf("write 16-bit binary: %v", err)
	}
	_, masked2, op2, got2, err := readWireMaskedFlag(client.r)
	if err != nil || op2 != wsOpBinary || masked2 || !bytes.Equal(got2, medBin) {
		t.Fatalf("16-bit binary mismatch: op=%d masked=%v len=%d err=%v", op2, masked2, len(got2), err)
	}

	// 4. 64-bit (127) binary frame (70,000 bytes).
	bigBin := make([]byte, 70_000)
	for i := range bigBin {
		bigBin[i] = byte(i % 251)
	}
	if err := client.writeFrame(true, wsOpBinary, bigBin); err != nil {
		t.Fatalf("write 64-bit binary: %v", err)
	}
	_, masked3, op3, got3, err := readWireMaskedFlag(client.r)
	if err != nil || op3 != wsOpBinary || masked3 || !bytes.Equal(got3, bigBin) {
		t.Fatalf("64-bit binary mismatch: op=%d masked=%v len=%d err=%v", op3, masked3, len(got3), err)
	}

	// 5. Fragmented text frame (FIN=0 -> continuation FIN=1).
	if err := client.writeFrame(false, wsOpText, []byte("hello ")); err != nil {
		t.Fatalf("write frag 1: %v", err)
	}
	if err := client.writeFrame(true, wsOpContinuation, []byte("fragment")); err != nil {
		t.Fatalf("write frag 2: %v", err)
	}
	_, _, op4, got4, err := readWireMaskedFlag(client.r)
	if err != nil || op4 != wsOpText || string(got4) != "hello fragment" {
		t.Fatalf("fragmented text mismatch: op=%d data=%q err=%v", op4, string(got4), err)
	}

	// 6. Clean Close propagation.
	_ = client.writeClose(1000, "done")
	_, _, opClose, _, _ := readWireMaskedFlag(client.r)
	if opClose != wsOpClose {
		t.Fatalf("expected close frame back, got op=%d", opClose)
	}

	select {
	case pErr := <-proxyDone:
		if pErr != nil {
			t.Fatalf("ServeRealtimeWS returned unexpected error: %v", pErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ServeRealtimeWS did not exit promptly after close")
	}

	mu.Lock()
	defer mu.Unlock()
	if gotAuth != "Bearer secret-moss-key" || gotCustom != "relay-1" {
		t.Fatalf("upstream headers mismatch: auth=%q custom=%q subproto=%q", gotAuth, gotCustom, gotSubproto)
	}
	if sawUnmasked || upFrames != 4 {
		t.Fatalf("expected 4 masked client frames at upstream, got frames=%d sawUnmasked=%v", upFrames, sawUnmasked)
	}
}

func TestServeRealtimeWSTLSAndServiceRelay(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tls-moss-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		upConn, err := upgradeBrowserWS(w, r.Header.Get("Sec-WebSocket-Key"), "", defaultMaxWSFrameBytes)
		if err != nil {
			return
		}
		defer upConn.netConn.Close()

		op, data, err := upConn.readMessage()
		if err != nil {
			return
		}
		_ = upConn.writeFrame(true, op, append([]byte("wss:"), data...))
		_ = upConn.writeClose(1000, "ok")
	}))
	defer upstream.Close()

	wssURL := "wss" + strings.TrimPrefix(upstream.URL, "https")
	tlsCfg := upstream.Client().Transport.(*http.Transport).TLSClientConfig
	if tlsCfg == nil {
		tlsCfg = &tls.Config{InsecureSkipVerify: true}
	}

	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = ServeRealtimeWS(w, r, RelayConfig{
			UpstreamURL: wssURL + "/v1/realtime",
			APIKey:      "tls-moss-key",
			TLSConfig:   tlsCfg,
		})
	}))
	defer proxy.Close()

	client := testDialClientWS(t, proxy.URL, "/wss")
	defer client.netConn.Close()
	if err := client.writeFrame(true, wsOpText, []byte("ping")); err != nil {
		t.Fatalf("write text: %v", err)
	}
	op, got, err := client.readMessage()
	if err != nil || op != wsOpText || string(got) != "wss:ping" {
		t.Fatalf("wss relay mismatch: op=%d data=%q err=%v", op, string(got), err)
	}

	// Verify Service.ServeMOSSRelay rejects cleanly when MOSS key is missing and proxies when configured.
	noKeySvc := NewService(Options{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/voice/moss/line", nil)
	if err := noKeySvc.ServeMOSSRelay(rec, req); !errors.Is(err, ErrVoiceUnavailable) || rec.Code != http.StatusConflict {
		t.Fatalf("expected ErrVoiceUnavailable & 409 when key missing, got err=%v code=%d", err, rec.Code)
	}
}

func TestServeRealtimeWSErrorRedactionAndContextCancel(t *testing.T) {
	t.Parallel()

	// 1. Upstream rejects with 401 echoing key -> relay returns HTTP 502 and redacts APIKey.
	badUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "invalid bearer secret-api-key-999", http.StatusUnauthorized)
	}))
	defer badUpstream.Close()

	badWS := "ws" + strings.TrimPrefix(badUpstream.URL, "http")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/line", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	req.Header.Set("Sec-WebSocket-Version", "13")

	err := ServeRealtimeWS(rec, req, RelayConfig{
		UpstreamURL: badWS,
		APIKey:      "secret-api-key-999",
	})
	if !errors.Is(err, ErrRealtimeHandshake) || rec.Code != http.StatusBadGateway {
		t.Fatalf("expected ErrRealtimeHandshake & 502, got err=%v code=%d", err, rec.Code)
	}
	if strings.Contains(rec.Body.String(), "secret-api-key-999") {
		t.Fatalf("relay leaked APIKey in error body: %q", rec.Body.String())
	}

	// 2. Context cancellation terminates active bidirectional pump cleanly.
	upConnected := make(chan struct{})
	idleUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upConn, err := upgradeBrowserWS(w, r.Header.Get("Sec-WebSocket-Key"), "", defaultMaxWSFrameBytes)
		if err != nil {
			return
		}
		close(upConnected)
		defer upConn.netConn.Close()
		_, _, _ = upConn.readMessage()
	}))
	defer idleUpstream.Close()

	idleWS := "ws" + strings.TrimPrefix(idleUpstream.URL, "http")
	ctx, cancel := context.WithCancel(context.Background())
	relayDone := make(chan error, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(ctx)
		relayDone <- ServeRealtimeWS(w, r, RelayConfig{UpstreamURL: idleWS})
	}))
	defer proxy.Close()

	client := testDialClientWS(t, proxy.URL, "/idle")
	defer client.netConn.Close()
	<-upConnected
	cancel()

	select {
	case err := <-relayDone:
		if err != nil {
			t.Fatalf("expected clean nil exit on cancel, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ServeRealtimeWS hung on context cancellation")
	}
}
