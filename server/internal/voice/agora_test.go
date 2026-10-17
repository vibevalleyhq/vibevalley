package voice

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"go.uber.org/fx"

	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/agora"
	"vibevalley/pkg/x/ptr"
)

// Requests are checked against testdata/voice-requests.json, a frozen golden that changes by hand with voice_agora.go.

const (
	voiceTestAppID = "11111111111111111111111111111111"
	voiceTestCert  = "22222222222222222222222222222222"
)

type voiceCapture struct {
	mu       sync.Mutex
	urls     []string
	requests []map[string]any
	status   int
	body     string
}

func (c *voiceCapture) Do(req *http.Request) (*http.Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.urls = append(c.urls, req.Method+" "+req.URL.String())
	var body map[string]any
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		json.Unmarshal(raw, &body)
	}
	c.requests = append(c.requests, body)
	status, answer := c.status, c.body
	if status == 0 {
		status, answer = 200, `{"agent_id":"parity-agent"}`
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(answer))}, nil
}

func voiceJSONOf(t *testing.T, v any) any {
	t.Helper()
	body, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	json.Unmarshal(body, &out)
	return out
}

func TestVoiceRequestsMatchGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/voice-requests.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name        string                 `json:"name"`
		Voice       protocol.VoiceSettings `json:"voice"`
		Keys        struct{ AsrKey, LlmKey, TtsKey string }
		DeepseekKey string         `json:"deepseekKey"`
		Line        *CallLine      `json:"line"`
		Request     map[string]any `json:"request"`
		RequestURL  string         `json:"requestUrl"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			vendors, problem := voiceVendorsFor(c.Voice, setting.VoiceKeys{ASRKey: c.Keys.AsrKey, LLMKey: c.Keys.LlmKey, TTSKey: c.Keys.TtsKey}, c.DeepseekKey, c.Line)
			if problem != "" {
				t.Fatal(problem)
			}
			capture := &voiceCapture{}
			client := agora.NewClient(agora.Credentials{AppID: voiceTestAppID, AppCertificate: voiceTestCert}, voiceAreaOf(c.Voice.Area), capture)
			id, err := client.Start(context.Background(), voiceAgentConfig(c.Voice), vendors, agora.Session{Name: "parity", Channel: "parity-channel", AgentUID: protocol.VoiceAgentUID, UID: "10001", IdleSeconds: int(c.Voice.IdleSeconds)})
			if err != nil || id != "parity-agent" {
				t.Fatalf("start: %q %v", id, err)
			}
			if got := capture.urls[0]; got != "POST "+c.RequestURL {
				t.Fatalf("endpoint: %s, golden %s", got, c.RequestURL)
			}
			request := capture.requests[0]
			// The app ID is repeated in the body; the token is signed with the time in it.
			if request["appid"] != voiceTestAppID {
				t.Fatalf("app id: %v", request["appid"])
			}
			delete(request, "appid")
			request["properties"].(map[string]any)["token"] = "parity-token"
			if got, want := voiceJSONOf(t, request), voiceJSONOf(t, c.Request); !reflect.DeepEqual(got, want) {
				a, _ := json.MarshalIndent(got, "", "  ")
				b, _ := json.MarshalIndent(want, "", "  ")
				t.Fatalf("request differs from the golden\ngot=%s\nwant=%s", a, b)
			}
		})
	}
}

func TestVoiceVendorsSayWhichKeyIsMissing(t *testing.T) {
	d := protocol.DefaultVoice()
	with := func(f func(*protocol.VoiceSettings)) protocol.VoiceSettings { v := d; f(&v); return v }
	if _, problem := voiceVendorsFor(d, setting.VoiceKeys{}, "", nil); problem != "" {
		t.Fatalf("Agora-hosted vendors need no key: %s", problem)
	}
	deepseek := with(func(v *protocol.VoiceSettings) {
		v.Answer = protocol.VoiceAnswer{Value: protocol.VoiceAnswerDeepseek{Model: "deepseek-chat"}}
	})
	if _, problem := voiceVendorsFor(deepseek, setting.VoiceKeys{}, "", nil); !strings.Contains(problem, "DeepSeek") {
		t.Fatalf("deepseek: %q", problem)
	}
	if _, problem := voiceVendorsFor(deepseek, setting.VoiceKeys{}, "sk-x", nil); problem != "" {
		t.Fatalf("deepseek with a key: %q", problem)
	}
	asr := with(func(v *protocol.VoiceSettings) {
		v.ASR = protocol.VoiceASR{Value: protocol.VoiceASRMicrosoft{Region: "eastasia"}}
	})
	if _, problem := voiceVendorsFor(asr, setting.VoiceKeys{}, "", nil); !strings.Contains(problem, "识别") {
		t.Fatalf("microsoft asr: %q", problem)
	}
	llm := with(func(v *protocol.VoiceSettings) {
		v.Answer = protocol.VoiceAnswer{Value: protocol.VoiceAnswerOpenai{URL: "https://x/v1/chat/completions", Model: "m"}}
	})
	if _, problem := voiceVendorsFor(llm, setting.VoiceKeys{}, "", nil); !strings.Contains(problem, "大模型") {
		t.Fatalf("own llm: %q", problem)
	}
	tts := with(func(v *protocol.VoiceSettings) {
		v.TTS = protocol.VoiceTTS{Value: protocol.VoiceTTSMicrosoft{Region: "eastasia", VoiceName: "zh-CN-XiaoxiaoNeural"}}
	})
	if _, problem := voiceVendorsFor(tts, setting.VoiceKeys{}, "", nil); !strings.Contains(problem, "合成") {
		t.Fatalf("microsoft tts: %q", problem)
	}
	hosted := with(func(v *protocol.VoiceSettings) {
		v.ASR = protocol.VoiceASR{Value: protocol.VoiceASRDeepgram{Model: protocol.ModelNova3}}
		v.TTS = protocol.VoiceTTS{Value: protocol.VoiceTTSOpenai{Voice: protocol.VoiceNova}}
	})
	if _, problem := voiceVendorsFor(hosted, setting.VoiceKeys{}, "", nil); problem != "" {
		t.Fatalf("deepgram and openai tts: %q", problem)
	}
	vibevalley := with(func(v *protocol.VoiceSettings) { v.Answer = protocol.VoiceAnswer{Value: protocol.VoiceAnswerManager{}} })
	if _, problem := voiceVendorsFor(vibevalley, setting.VoiceKeys{}, "", nil); !strings.Contains(problem, "语音线路") {
		t.Fatalf("vibevalley without a line: %q", problem)
	}
}

// Go does not check a type switch for every member: a member added to VoiceASR, VoiceAnswer or VoiceTTS fails here until it is handled.
func TestVoiceVendorsKnowEveryVendor(t *testing.T) {
	keys := setting.VoiceKeys{ASRKey: "k", LLMKey: "k", TTSKey: "k"}
	line := &CallLine{ID: "l", URL: "http://127.0.0.1:1/v1/chat/completions", Key: "k"}
	knows := func(member any, v protocol.VoiceSettings) {
		if _, problem := voiceVendorsFor(v, keys, "sk-x", line); strings.Contains(problem, voiceUnknown) {
			t.Errorf("%T: %s", member, problem)
		}
	}
	for _, m := range protocol.VoiceASRMembers {
		v := protocol.DefaultVoice()
		v.ASR = protocol.VoiceASR{Value: m}
		knows(m, v)
	}
	for _, m := range protocol.VoiceAnswerMembers {
		v := protocol.DefaultVoice()
		v.Answer = protocol.VoiceAnswer{Value: m}
		knows(m, v)
	}
	for _, m := range protocol.VoiceTTSMembers {
		v := protocol.DefaultVoice()
		v.TTS = protocol.VoiceTTS{Value: m}
		knows(m, v)
	}
}

func voiceTestFarm(t *testing.T) *world {
	t.Helper()
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Voice.Line.Port, cfg.Voice.Line.URL = 0, "https://line.example.com"
	f, err := newWorld(cfg, fx.Replace(setting.New(cfg)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return f
}

func TestVoiceSessionsNeedCredentials(t *testing.T) {
	f := voiceTestFarm(t)
	ctx := context.Background()
	var unavailable protocol.VoiceUnavailable
	if _, err := f.Voice.Session(ctx); !errors.As(err, &unavailable) || !strings.Contains(unavailable.Reason, "App ID") {
		t.Fatalf("without credentials: %v", err)
	}
	if _, err := f.Setting.Save(protocol.SettingsUpdate{AgoraAppID: ptr.To(voiceTestAppID), AgoraAppCertificate: ptr.To(voiceTestCert)}); err != nil {
		t.Fatal(err)
	}
	s, err := f.Voice.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if s.AppID != voiceTestAppID || !strings.HasPrefix(s.Channel, "vibevalley-") || s.UID == "" || !strings.HasPrefix(s.Token, "007") {
		t.Fatalf("session: %+v", s)
	}
	renewed, err := f.Voice.Renew(ctx, s.Channel, s.UID)
	if err != nil || renewed.Channel != s.Channel || renewed.UID != s.UID || renewed.Token == "" {
		t.Fatalf("renew: %+v %v", renewed, err)
	}
}

func TestVoiceStartAndStopTheManagerOnHisLine(t *testing.T) {
	f := voiceTestFarm(t)
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	capture := &voiceCapture{}
	f.Voice.http = capture
	ctx := context.Background()
	if _, err := f.Setting.Save(protocol.SettingsUpdate{AgoraAppID: ptr.To(voiceTestAppID), AgoraAppCertificate: ptr.To(voiceTestCert),
		Voice: &protocol.SettingsUpdateVoice{Answer: protocol.VoiceAnswer{Value: protocol.VoiceAnswerManager{}}}}); err != nil {
		t.Fatal(err)
	}
	agent, err := f.Voice.Start(ctx, "ch1", "4242")
	if err != nil || agent.AgentID != "parity-agent" {
		t.Fatalf("start: %+v %v", agent, err)
	}
	props := capture.requests[0]["properties"].(map[string]any)
	llm := props["llm"].(map[string]any)
	if !strings.HasPrefix(llm["url"].(string), "https://line.example.com/llm/") || llm["api_key"] == "" {
		t.Fatalf("the manager's line: %v", llm)
	}
	if props["parameters"].(map[string]any)["data_channel"] != "datastream" || props["advanced_features"].(map[string]any)["enable_rtm"] != false {
		t.Fatalf("captions: %v %v", props["parameters"], props["advanced_features"])
	}
	if got := props["remote_rtc_uids"]; !reflect.DeepEqual(got, []any{"4242"}) {
		t.Fatalf("only the page's user is listened to: %v", got)
	}
	if n := len(f.Voice.keys); n != 1 {
		t.Fatalf("one line open, not %d", n)
	}
	capture.status, capture.body = 400, `{"detail":"Agent is already in the process of shutting down"}`
	if err := f.Voice.Stop(ctx, agent.AgentID); err != nil {
		t.Fatal(err)
	}
	if n := len(f.Voice.keys); n != 0 {
		t.Fatalf("the line stays open: %d", n)
	}
	capture.status, capture.body = 500, `{"detail":"boom"}`
	var failed protocol.VoiceAgentFailed
	if err := f.Voice.Stop(ctx, "other"); !errors.As(err, &failed) {
		t.Fatalf("a real failure: %v", err)
	}
}

func TestVoiceCallOwnsItsCredentialsAndLine(t *testing.T) {
	f := voiceTestFarm(t)
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	capture := &voiceCapture{}
	f.Voice.http = capture
	if _, err := f.Setting.Save(protocol.SettingsUpdate{AgoraAppID: ptr.To(voiceTestAppID), AgoraAppCertificate: ptr.To(voiceTestCert), Voice: &protocol.SettingsUpdateVoice{Area: ptr.To(protocol.AreaEU), Answer: protocol.VoiceAnswer{Value: protocol.VoiceAnswerManager{}}}}); err != nil {
		t.Fatal(err)
	}
	agent, err := f.Voice.Start(context.Background(), "ch1", "42")
	if err != nil {
		t.Fatal(err)
	}
	started := capture.urls[0]
	if _, err := f.Setting.Save(protocol.SettingsUpdate{AgoraAppID: ptr.To("33333333333333333333333333333333"), Voice: &protocol.SettingsUpdateVoice{Area: ptr.To(protocol.AreaUS)}}); err != nil {
		t.Fatal(err)
	}
	capture.status, capture.body = 500, `{"detail":"temporary failure"}`
	if err := f.Voice.Stop(context.Background(), agent.AgentID); err == nil {
		t.Fatal("expected remote stop failure")
	}
	if len(f.Voice.keys) != 0 {
		t.Fatal("failed remote stop retained local line")
	}
	capture.status, capture.body = 200, `{}`
	if err := f.Voice.Stop(context.Background(), agent.AgentID); err != nil {
		t.Fatal(err)
	}
	for _, url := range capture.urls[1:] {
		if !strings.Contains(url, voiceTestAppID) || strings.Contains(url, "33333333333333333333333333333333") {
			t.Fatalf("call used changed credentials: %s (started %s)", url, started)
		}
		if strings.Contains(started, "api-eu") && !strings.Contains(url, "api-eu") {
			t.Fatalf("call used changed area: %s", url)
		}
	}
	if len(f.Voice.calls) != 0 {
		t.Fatal("successfully stopped call retained its lease")
	}
}
