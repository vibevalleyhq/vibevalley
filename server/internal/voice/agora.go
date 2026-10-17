package voice

// voice_agora_test.go checks the requests against testdata/voice-requests.json.

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/AgoraIO/agora-agents-go/v2/agentkit"
	"github.com/AgoraIO/agora-agents-go/v2/agentkit/vendors"
	sdkcore "github.com/AgoraIO/agora-agents-go/v2/core"
	"github.com/AgoraIO/agora-agents-go/v2/option"

	"vibevalley/internal/channel"
	"vibevalley/internal/core"
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
func voiceAgentFor(client *agentkit.AgoraClient, voice protocol.VoiceSettings, v agora.Vendors) *agentkit.Agent {
	return agora.NewAgent(client, agora.Agent{
		Language: string(voice.Language), Persona: voice.Persona, InterruptMs: voice.InterruptMs, SilenceMs: voice.SilenceMs,
		Captions: agora.CaptionsDataStream,
	}, v)
}

// No caller since the embedding host with native voice (MyGo) was removed.
type VoiceNative struct {
	Credentials agora.Credentials
	Area        option.Area
	IdleSeconds int
	Agent       func(client *agentkit.AgoraClient) *agentkit.Agent
	Done        func()
}

type voice struct {
	core      *core.Service
	settings  *setting.Service
	chat      *channel.Service
	voiceLine *voiceLine
	http      sdkcore.HTTPClient

	mu    sync.Mutex
	lines map[string]string
	// The calls on that Agora's model answers, and the greeting each says at pickup: their words reach 田头 only through Said.
	quick map[string]string
}

func newVoice(core *core.Service, settings *setting.Service, chat *channel.Service, line *voiceLine) (*voice, error) {
	return &voice{core: core, settings: settings, chat: chat, voiceLine: line, http: &http.Client{Timeout: 25 * time.Second}, lines: map[string]string{}, quick: map[string]string{}}, nil
}
func (*voice) OnStart(context.Context) error { return nil }
func (*voice) OnStop()                       {}

var voiceMissing = protocol.VoiceUnavailable{Reason: "还没有 Agora 的凭据：在首页的「设置」里填 App ID 和 App Certificate"}

// Asked each time: credentials saved from the title screen work without a restart.
func (v *voice) creds() (agora.Credentials, error) {
	c := v.settings.Agora()
	if c == nil {
		return agora.Credentials{}, voiceMissing
	}
	return *c, nil
}

func (v *voice) issue(channel, uid string) (protocol.AgoraTicket, error) {
	c, err := v.creds()
	if err != nil {
		return protocol.AgoraTicket{}, err
	}
	token, err := agora.Token(c, channel, uid)
	if err != nil {
		return protocol.AgoraTicket{}, protocol.VoiceUnavailable{Reason: "签不出语音令牌：" + err.Error()}
	}
	return protocol.AgoraTicket{AppID: c.AppID, Channel: channel, UID: uid, Token: token}, nil
}

func (v *voice) Session(ctx context.Context) (protocol.AgoraTicket, error) {
	return v.issue(agora.NewChannel("vibevalley"), agora.NewUID())
}

func (v *voice) Renew(ctx context.Context, channel, uid string) (protocol.AgoraTicket, error) {
	return v.issue(channel, uid)
}

func (v *voice) client(c agora.Credentials, area protocol.Area) *agentkit.AgoraClient {
	return agora.NewClient(c, voiceAreaOf(area), v.http)
}

func (v *voice) prepare() (protocol.VoiceSettings, *CallLine, agora.Vendors, error) {
	voice := v.settings.Voice()
	var line *CallLine
	if _, ok := voice.Answer.Value.(protocol.VoiceAnswerManager); ok {
		opened, err := v.voiceLine.Open()
		if err != nil {
			return voice, nil, agora.Vendors{}, protocol.VoiceUnavailable{Reason: "管家的语音线路接不通：" + err.Error()}
		}
		line = &opened
	}
	vendors, problem := voiceVendorsFor(voice, v.settings.VoiceKeys(), v.settings.DeepseekAPIKey(), line)
	if problem != "" {
		if line != nil {
			v.voiceLine.Close(line.ID)
		}
		return voice, nil, agora.Vendors{}, protocol.VoiceUnavailable{Reason: problem}
	}
	return voice, line, vendors, nil
}

func (v *voice) Start(ctx context.Context, channel, uid string) (protocol.VoiceAgent, error) {
	agent, err := v.start(ctx, channel, uid)
	if err == nil {
		v.core.Did(core.OwnerDid{Kind: core.OwnerTalked})
	}
	return agent, err
}

func (v *voice) start(ctx context.Context, channel, uid string) (protocol.VoiceAgent, error) {
	c, err := v.creds()
	if err != nil {
		return protocol.VoiceAgent{}, err
	}
	voice, line, vendors, err := v.prepare()
	if err != nil {
		return protocol.VoiceAgent{}, err
	}
	idle := int(voice.IdleSeconds)
	session := voiceAgentFor(v.client(c, voice.Area), voice, vendors).CreateSession(agentkit.CreateSessionOptions{
		Channel:     channel,
		AgentUID:    protocol.VoiceAgentUID,
		RemoteUIDs:  []string{uid},
		IdleTimeout: &idle,
		ExpiresIn:   3600,
	})
	id, err := session.Start(ctx)
	if err != nil {
		if line != nil {
			v.voiceLine.Close(line.ID)
		}
		return protocol.VoiceAgent{}, protocol.VoiceAgentFailed{Reason: "请管家进频道失败：" + err.Error()}
	}
	v.mu.Lock()
	if line != nil {
		v.lines[id] = line.ID
	} else {
		v.quick[id] = strings.TrimSpace(voice.Greeting)
	}
	v.mu.Unlock()
	return protocol.VoiceAgent{AgentID: id}, nil
}

// Only a call still on, that Agora's model answers: a late turn after hangup, or the manager's words, are not kept twice. The greeting
// is said at every pickup and not kept.
func (v *voice) Said(agentID, text string) error {
	v.mu.Lock()
	greeting, quick := v.quick[agentID]
	_, managed := v.lines[agentID]
	v.mu.Unlock()
	if !quick && !managed {
		return protocol.VoiceAgentFailed{Reason: "这通电话已经挂了"}
	}
	if quick && strings.TrimSpace(text) != greeting {
		v.chat.Spoken(protocol.ManagerAgent, text)
	}
	return nil
}

// Its voice line closes whatever Agora says.
func (v *voice) Stop(ctx context.Context, agentID string) error {
	defer func() {
		v.mu.Lock()
		line, ok := v.lines[agentID]
		delete(v.lines, agentID)
		delete(v.quick, agentID)
		v.mu.Unlock()
		if ok {
			v.voiceLine.Close(line)
		}
	}()
	c, err := v.creds()
	if err != nil {
		return err
	}
	if err := v.client(c, v.settings.Voice().Area).StopAgent(ctx, agentID); err != nil && !agora.AlreadyStopping(err) {
		return protocol.VoiceAgentFailed{Reason: "请管家离开失败：" + err.Error()}
	}
	return nil
}

// No caller since MyGo was removed.
func (v *voice) Native() (VoiceNative, error) {
	c, err := v.creds()
	if err != nil {
		return VoiceNative{}, err
	}
	voice, line, vendors, err := v.prepare()
	if err != nil {
		return VoiceNative{}, err
	}
	var once sync.Once
	return VoiceNative{
		Credentials: c,
		Area:        voiceAreaOf(voice.Area),
		IdleSeconds: int(voice.IdleSeconds),
		Agent: func(client *agentkit.AgoraClient) *agentkit.Agent {
			return voiceAgentFor(client, voice, vendors)
		},
		Done: func() {
			once.Do(func() {
				if line != nil {
					v.voiceLine.Close(line.ID)
				}
			})
		},
	}, nil
}
