package voice

// voice_agora_test.go checks the requests against testdata/voice-requests.json.

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/AgoraIO/agora-agents-go/v2/agentkit/vendors"
	sdkcore "github.com/AgoraIO/agora-agents-go/v2/core"
	"github.com/AgoraIO/agora-agents-go/v2/option"

	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/manager"
	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/pkg/agora"
)

const voiceDeepseekChat = "https://api.deepseek.com/chat/completions"

func voiceAreaOf(area protocol.Area) option.Area {
	switch area {
	case protocol.AreaEU:
		return option.AreaEU
	case protocol.AreaAP:
		return option.AreaAP
	case protocol.AreaCN:
		return option.AreaCN
	case protocol.AreaUS:
		return option.AreaUS
	}
	return option.AreaUS
}

// For a member added to VoiceASR, VoiceAnswer or VoiceTTS and not to voiceVendorsFor; TestVoiceVendorsKnowEveryVendor catches it (Go does not check a
// type switch for every member).
const voiceUnknown = "服务端还不会用"

// Agora-hosted vendors need no key of their own. line nil: the manager does not answer the call itself.
func voiceVendorsFor(voice protocol.VoiceSettings, keys setting.VoiceKeys, deepseekKey string, line *CallLine) (v agora.Vendors, problem string) {
	// agentkit panics on a configuration it refuses; that is a problem with the settings, not the server's.
	defer func() {
		if r := recover(); r != nil {
			v, problem = agora.Vendors{}, fmt.Sprintf("语音设置用不了：%v", r)
		}
	}()
	speech := func(o vendors.OpenAIOptions) *vendors.OpenAI {
		return agora.SpeakingLLM(o, voice.Greeting, voice.FailureMessage)
	}
	switch asr := voice.ASR.Value.(type) {
	case protocol.VoiceASRAres:
		v.STT = vendors.NewAresSTT()
	case protocol.VoiceASRDeepgram:
		v.STT = vendors.NewDeepgramSTT(vendors.DeepgramSTTOptions{Model: string(asr.Model), Language: string(voice.Language)})
	case protocol.VoiceASRMicrosoft:
		if keys.ASRKey == "" {
			return agora.Vendors{}, "微软识别还没有 key：在声音页的「识别」里填"
		}
		v.STT = vendors.NewMicrosoftSTT(vendors.MicrosoftSTTOptions{Key: keys.ASRKey, Region: asr.Region, Language: string(voice.Language)})
	case nil:
		return agora.Vendors{}, "语音设置里没有选识别"
	default:
		return agora.Vendors{}, fmt.Sprintf("识别用的 %T %s", asr, voiceUnknown)
	}
	switch llm := voice.Answer.Value.(type) {
	case protocol.VoiceAnswerManager:
		if line == nil {
			return agora.Vendors{}, "管家的语音线路没接通"
		}
		v.LLM = speech(vendors.OpenAIOptions{APIKey: line.Key, BaseURL: line.URL, Model: protocol.ManagerModel})
	case protocol.VoiceAnswerAgora:
		v.LLM = speech(vendors.OpenAIOptions{Model: string(llm.Model)})
	case protocol.VoiceAnswerDeepseek:
		if deepseekKey == "" {
			return agora.Vendors{}, "用 DeepSeek 要先有 DeepSeek 的 key：在首页「设置」里填"
		}
		v.LLM = speech(vendors.OpenAIOptions{APIKey: deepseekKey, BaseURL: voiceDeepseekChat, Model: llm.Model})
	case protocol.VoiceAnswerOpenai:
		if keys.LLMKey == "" {
			return agora.Vendors{}, "自己的大模型还没有 key：在声音页的「想」里填"
		}
		v.LLM = speech(vendors.OpenAIOptions{APIKey: keys.LLMKey, BaseURL: llm.URL, Model: llm.Model})
	case nil:
		return agora.Vendors{}, "语音设置里没有选大模型"
	default:
		return agora.Vendors{}, fmt.Sprintf("大模型用的 %T %s", llm, voiceUnknown)
	}
	switch tts := voice.TTS.Value.(type) {
	case protocol.VoiceTTSMinimax:
		v.TTS = vendors.NewMiniMaxTTS(vendors.MiniMaxTTSOptions{Model: string(tts.Model), VoiceID: tts.VoiceID})
	case protocol.VoiceTTSOpenai:
		v.TTS = vendors.NewOpenAITTS(vendors.OpenAITTSOptions{Voice: string(tts.Voice)})
	case protocol.VoiceTTSMicrosoft:
		if keys.TTSKey == "" {
			return agora.Vendors{}, "微软合成还没有 key：在声音页的「说」里填"
		}
		v.TTS = vendors.NewMicrosoftTTS(vendors.MicrosoftTTSOptions{Key: keys.TTSKey, Region: tts.Region, VoiceName: tts.VoiceName})
	case nil:
		return agora.Vendors{}, "语音设置里没有选合成"
	default:
		return agora.Vendors{}, fmt.Sprintf("合成用的 %T %s", tts, voiceUnknown)
	}
	return v, ""
}

// Read at each start: a change takes effect on the next call. Captions go over the RTC data stream: Agora's Flutter RTM is
// Android and iOS only, and the client runs on macOS.
func voiceAgentConfig(voice protocol.VoiceSettings) agora.Agent {
	return agora.Agent{Language: string(voice.Language), Persona: voice.Persona, InterruptMs: voice.InterruptMs, SilenceMs: voice.SilenceMs, Captions: agora.CaptionsDataStream}
}

type voice struct {
	core      *core.Service
	settings  *setting.Service
	chat      *channel.Service
	voiceLine *voiceLine
	http      sdkcore.HTTPClient
	heard     func(text, agent, sendKey string) error

	mu      sync.Mutex
	calls   map[string]voiceCall
	grants  map[rtcIdentity]*rtcGrant
	now     func() time.Time
	stopped bool
}

type voiceCall struct {
	grant   rtcIdentity
	client  *agora.Client
	release func()
	// Agora's model answers, so its words reach 田头 only through Said; the manager's own reach it as it says them.
	quick bool
	// Said at every pickup; not worth keeping in 田头.
	greeting string
	ending   bool
}

func newVoice(core *core.Service, settings *setting.Service, chat *channel.Service, mgr *manager.Service, line *voiceLine) (*voice, error) {
	return &voice{core: core, settings: settings, chat: chat, voiceLine: line, heard: mgr.Heard, http: &http.Client{Timeout: 25 * time.Second}, calls: map[string]voiceCall{}, grants: map[rtcIdentity]*rtcGrant{}, now: time.Now}, nil
}
func (*voice) OnStart(context.Context) error { return nil }

var voiceMissing = protocol.VoiceUnavailable{Reason: "还没有 Agora 的凭据：在首页的「设置」里填 App ID 和 App Certificate"}

// Asked each time: credentials saved from the title screen work without a restart.
func (v *voice) creds() (agora.Credentials, error) {
	c := v.settings.Agora()
	if c == nil {
		return agora.Credentials{}, voiceMissing
	}
	return *c, nil
}

func (v *voice) client(c agora.Credentials, area protocol.Area) *agora.Client {
	return agora.NewClient(c, voiceAreaOf(area), v.http)
}

func (v *voice) Start(ctx context.Context, channel, uid string) (protocol.VoiceAgent, error) {
	agent, err := v.start(ctx, channel, uid)
	if err == nil {
		v.core.Did(core.OwnerDid{Kind: core.OwnerTalked})
	}
	return agent, err
}

func (v *voice) start(ctx context.Context, channel, uid string) (result protocol.VoiceAgent, err error) {
	key := rtcIdentity{channel, uid}
	grant, err := v.takeGrant(key)
	if err != nil {
		return result, err
	}
	defer func() {
		if err != nil {
			v.revokeGrant(key, grant)
		}
	}()
	c := grant.credentials
	config := v.settings.VoiceConfig()
	settings := config.Voice
	var line *CallLine
	release := func() {}
	if _, ok := settings.Answer.Value.(protocol.VoiceAnswerManager); ok {
		opened, err := v.voiceLine.Open()
		if err != nil {
			return result, protocol.VoiceUnavailable{Reason: "管家的语音线路接不通：" + err.Error()}
		}
		line = &opened
		var once sync.Once
		release = func() { once.Do(func() { v.voiceLine.Close(opened.ID) }) }
	}
	defer func() {
		if err != nil {
			release()
		}
	}()
	vendors, problem := voiceVendorsFor(settings, config.Keys, config.DeepseekAPIKey, line)
	if problem != "" {
		return result, protocol.VoiceUnavailable{Reason: problem}
	}
	client := v.client(c, settings.Area)
	id, err := client.Start(ctx, voiceAgentConfig(settings), vendors, agora.Session{Channel: channel, AgentUID: protocol.VoiceAgentUID, UID: uid, IdleSeconds: int(settings.IdleSeconds)})
	if err != nil {
		return result, protocol.VoiceAgentFailed{Reason: "请管家进频道失败：" + err.Error()}
	}
	v.mu.Lock()
	if v.stopped || v.grants[key] != grant {
		v.mu.Unlock()
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Stop(cleanup, id)
		return result, protocol.VoiceUnavailable{Reason: "语音服务已经停下"}
	}
	grant.agent, grant.starting = id, false
	v.calls[id] = voiceCall{grant: key, client: client, release: release, quick: line == nil, greeting: strings.TrimSpace(settings.Greeting)}
	v.mu.Unlock()
	return protocol.VoiceAgent{AgentID: id}, nil
}

// The v1 relay has no call id. Ambiguous or absent call identity cannot be inferred from current settings.
func (v *voice) HeardCurrent(text, picked, sendKey string) error {
	v.mu.Lock()
	id := ""
	for key, call := range v.calls {
		if call.ending {
			continue
		}
		if id != "" {
			v.mu.Unlock()
			return protocol.VoiceAgentFailed{Reason: "有几通电话正在接通，请升级客户端后重试"}
		}
		id = key
	}
	v.mu.Unlock()
	if id == "" {
		return protocol.VoiceAgentFailed{Reason: "没有正在接通的电话"}
	}
	return v.Heard(id, text, picked, sendKey)
}

// Both transcript directions use the answer mode captured by this call, never the current settings.
func (v *voice) Heard(agentID, text, picked, sendKey string) error {
	v.mu.Lock()
	call, ok := v.calls[agentID]
	v.mu.Unlock()
	if !ok || call.ending {
		return protocol.VoiceAgentFailed{Reason: "这通电话已经挂了"}
	}
	if call.quick {
		v.core.Open()
		return v.heard(text, picked, sendKey)
	}
	return nil
}

// Only a call still on, that Agora's model answers: a late turn after hangup, or the manager's words, are not kept twice.
func (v *voice) Said(agentID, text string) error {
	v.mu.Lock()
	call, ok := v.calls[agentID]
	v.mu.Unlock()
	if !ok || call.ending {
		return protocol.VoiceAgentFailed{Reason: "这通电话已经挂了"}
	}
	if call.quick && strings.TrimSpace(text) != call.greeting {
		v.chat.Spoken(protocol.ManagerAgent, text, "")
	}
	return nil
}

// A call keeps the client it started with, even when settings change before hangup.
func (v *voice) Stop(ctx context.Context, agentID string) error {
	v.mu.Lock()
	call, ok := v.calls[agentID]
	if ok {
		delete(v.grants, call.grant)
		call.ending = true
		v.calls[agentID] = call
	}
	v.mu.Unlock()
	if ok {
		defer call.release()
	} else {
		c, err := v.creds()
		if err != nil {
			return err
		}
		call.client = v.client(c, v.settings.Voice().Area)
	}
	if err := call.client.Stop(ctx, agentID); err != nil {
		return protocol.VoiceAgentFailed{Reason: "请管家离开失败：" + err.Error()}
	}
	v.mu.Lock()
	delete(v.calls, agentID)
	v.mu.Unlock()
	return nil
}
