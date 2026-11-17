package voice

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
