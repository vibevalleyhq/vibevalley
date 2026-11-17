package voice

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	// VoiceAgentUID is the reserved Agora RTC UID used by the VibeValley conversational agent.
	VoiceAgentUID = "123456"

	maxDictationAudioBytes = 25 * 1024 * 1024
	maxSpeakPieceBytes     = 480
	defaultMOSSRealtimeURL = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"
)

// CallState tracks the active voice call lifecycle state.
type CallState string

const (
	CallIdle       CallState = "idle"
	CallConnecting CallState = "connecting"
	CallLive       CallState = "live"
	CallEnding     CallState = "ending"
	CallError      CallState = "error"
)

var (
	// ErrVoiceUnavailable indicates missing credentials, missing grant, or unreachable voice upstream.
	ErrVoiceUnavailable = errors.New("voice: unavailable")
	// ErrVoiceCallFailed indicates an Agora or realtime call lifecycle failure.
	ErrVoiceCallFailed = errors.New("voice: call failed")
	// ErrVoiceRefused indicates invalid dictation input or unsupported audio format.
	ErrVoiceRefused = errors.New("voice: refused")

	supportedDictationFormats = map[string]string{
		"wav":  "audio.wav",
		"mp3":  "audio.mp3",
		"webm": "audio.webm",
		"ogg":  "audio.ogg",
		"flac": "audio.flac",
		"m4a":  "audio.m4a",
		"mp4":  "audio.mp4",
		"mpeg": "audio.mpeg",
		"mpga": "audio.mpga",
	}
)

// AgoraGrant matches packages/protocol/src/voice/shapes.ts AgoraGrant.
type AgoraGrant struct {
	AppID   string `json:"appId"`
	Channel string `json:"channel"`
	UID     string `json:"uid"`
	Token   string `json:"token"`
}

// VoiceGrantRenew matches packages/protocol/src/voice/shapes.ts VoiceGrantRenew.
type VoiceGrantRenew struct {
	Channel string `json:"channel"`
	UID     string `json:"uid"`
}

// VoiceCallStart matches packages/protocol/src/voice/shapes.ts VoiceCallStart.
type VoiceCallStart struct {
	Channel string `json:"channel"`
	UID     string `json:"uid"`
	About   string `json:"about,omitempty"`
}

// VoiceCall matches packages/protocol/src/voice/shapes.ts VoiceCall.
type VoiceCall struct {
	AgentID string `json:"agentId"`
}

// VoiceHeard matches packages/protocol/src/voice/shapes.ts VoiceHeard.
type VoiceHeard struct {
	AgentID string `json:"agentId"`
	Text    string `json:"text"`
	Agent   string `json:"agent,omitempty"`
	SendKey string `json:"sendKey,omitempty"`
}

// VoiceSaid matches packages/protocol/src/voice/shapes.ts VoiceSaid.
type VoiceSaid struct {
	AgentID string `json:"agentId"`
	Text    string `json:"text"`
}

// DictateRequest matches packages/protocol/src/voice/shapes.ts DictateRequest.
type DictateRequest struct {
	Audio  string `json:"audio"`
	Format string `json:"format"`
}

// Dictated matches packages/protocol/src/voice/shapes.ts Dictated.
type Dictated struct {
	Text string `json:"text"`
}

// Validation matches packages/protocol/src/common/shapes.ts Validation.
type Validation struct {
	Problem string `json:"problem"`
}

// FactCallChanged matches packages/protocol/src/voice/shapes.ts FactCallChanged.
type FactCallChanged struct {
	Type   string    `json:"type"`
	At     int64     `json:"at"`
	State  CallState `json:"state"`
	Reason string    `json:"reason"`
}

// AgoraCredentials holds Agora project credentials and optional REST Basic credentials.
type AgoraCredentials struct {
	AppID          string
	AppCertificate string
	Area           string // "US", "EU", "AP", "CN"
	CustomerID     string
	CustomerSecret string
}

// DictationTarget configures OpenAI-compatible audio transcription calls.
type DictationTarget struct {
	URL   string
	Model string
	Key   string
}

// VoiceConfigSnapshot captures active voice call configuration resolved by the host.
type VoiceConfigSnapshot struct {
	Area           string
	Language       string
	AnswerVendor   string // "orchestrator", "moss", "agora", "deepseek", "openai"
	Greeting       string
	FailureMessage string
	Persona        string
	SilenceMs      int
	InterruptMs    int
	IdleSeconds    int
}

// Options configures a Voice Service with clean mockable transports and providers.
type Options struct {
	Clock            store.Clock
	HTTPClient       *http.Client
	AgoraBaseURLs    map[string]string
	MOSSStatusURL    string
	VoiceConfig      func() VoiceConfigSnapshot
	AgoraCredentials func() (AgoraCredentials, bool)
	DictationConfig  func() (DictationTarget, bool)
	MOSSKey          func() (string, bool)
	MOSSVerifyHook   func(ctx context.Context, key string) Validation
	OnHear           func(ctx context.Context, heard VoiceHeard) error
	OnSay            func(ctx context.Context, said VoiceSaid) error
	OnStateChanged   func(FactCallChanged)
	TokenSeconds     uint32
}

type grantPhase string

const (
	grantIssued   grantPhase = "issued"
	grantStarting grantPhase = "starting"
	grantActive   grantPhase = "on"
)

type activeGrant struct {
	kind    string // "agora" or "moss"
	creds   AgoraCredentials
	expires int64
	phase   grantPhase
	agentID string
}

type activeCall struct {
	kind     string
	grantKey string
	agentID  string
	creds    AgoraCredentials
	greeting string
	quick    bool
}

// Service manages Agora AccessToken2 voice grants, call lifecycle, dictation, and MOSS probes.
type Service struct {
	clock          store.Clock
	httpClient     *http.Client
	agoraBaseURLs  map[string]string
	mossStatusURL  string
	voiceConfigFn  func() VoiceConfigSnapshot
	agoraCredsFn   func() (AgoraCredentials, bool)
	dictationCfgFn func() (DictationTarget, bool)
	mossKeyFn      func() (string, bool)
	mossVerifyHook func(ctx context.Context, key string) Validation
	onHear         func(ctx context.Context, heard VoiceHeard) error
	onSay          func(ctx context.Context, said VoiceSaid) error
	onStateChanged func(FactCallChanged)
	tokenSeconds   uint32

	mu        sync.Mutex
	grants    map[string]*activeGrant
	calls     map[string]*activeCall
	callState FactCallChanged
}

// NewService constructs a Voice Service.
func NewService(opts Options) *Service {
	clk := opts.Clock
	if clk == nil {
		clk = store.RealClock{}
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	tokenSec := opts.TokenSeconds
	if tokenSec == 0 {
		tokenSec = DefaultTokenSeconds
	}
	baseURLs := map[string]string{
		"US": "https://api-us-west-1.agora.io",
		"EU": "https://api-eu-west-1.agora.io",
		"AP": "https://api-ap-southeast-1.agora.io",
		"CN": "https://api-cn-east-1.sd-rtn.com/cn",
	}
	for k, v := range opts.AgoraBaseURLs {
		baseURLs[strings.ToUpper(k)] = strings.TrimRight(v, "/")
	}
	mossStatusURL := strings.TrimSpace(opts.MOSSStatusURL)
	if mossStatusURL == "" {
		mossStatusURL = strings.Replace(defaultMOSSRealtimeURL, "wss://", "https://", 1)
	}
	voiceCfgFn := opts.VoiceConfig
	if voiceCfgFn == nil {
		voiceCfgFn = func() VoiceConfigSnapshot {
			return VoiceConfigSnapshot{
				Area:         "US",
				Language:     "zh-CN",
				AnswerVendor: "orchestrator",
				SilenceMs:    480,
				InterruptMs:  160,
				IdleSeconds:  30,
			}
		}
	}

	return &Service{
		clock:          clk,
		httpClient:     httpClient,
		agoraBaseURLs:  baseURLs,
		mossStatusURL:  mossStatusURL,
		voiceConfigFn:  voiceCfgFn,
		agoraCredsFn:   opts.AgoraCredentials,
		dictationCfgFn: opts.DictationConfig,
		mossKeyFn:      opts.MOSSKey,
		mossVerifyHook: opts.MOSSVerifyHook,
		onHear:         opts.OnHear,
		onSay:          opts.OnSay,
		onStateChanged: opts.OnStateChanged,
		tokenSeconds:   tokenSec,
		grants:         make(map[string]*activeGrant),
		calls:          make(map[string]*activeCall),
		callState: FactCallChanged{
			Type:  "callChanged",
			At:    clk.NowMs(),
			State: CallIdle,
		},
	}
}

// State returns the latest call state snapshot.
func (s *Service) State() FactCallChanged {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.callState
}

// GrantCreate provisions a fresh channel, UID, and signed AccessToken2 (or MOSS placeholder grant).
func (s *Service) GrantCreate(ctx context.Context) (AgoraGrant, error) {
	if err := ctx.Err(); err != nil {
		return AgoraGrant{}, err
	}
	cfg := s.voiceConfigFn()
	nowMs := s.clock.NowMs()
	channel := newChannelName(nowMs)
	uid := newNumericUID()

	if cfg.AnswerVendor == "moss" {
		if s.mossKeyFn == nil {
			return AgoraGrant{}, fmt.Errorf("%w: MOSS key is not configured", ErrVoiceUnavailable)
		}
		if key, ok := s.mossKeyFn(); !ok || strings.TrimSpace(key) == "" {
			return AgoraGrant{}, fmt.Errorf("%w: MOSS key is not configured", ErrVoiceUnavailable)
		}
		s.mu.Lock()
		s.pruneGrantsLocked(nowMs)
		s.grants[grantKey(channel, uid)] = &activeGrant{
			kind:    "moss",
			expires: nowMs + int64(s.tokenSeconds)*1000,
			phase:   grantIssued,
		}
		s.mu.Unlock()
		return AgoraGrant{AppID: "moss", Channel: channel, UID: uid, Token: "moss"}, nil
	}

	creds, err := s.requireAgoraCreds()
	if err != nil {
		return AgoraGrant{}, err
	}
	issueTs := uint32(s.clock.Now().Unix())
	token, err := BuildTokenWithRTMAt(creds.AppID, creds.AppCertificate, channel, uid, RolePublisher, issueTs, s.tokenSeconds, s.tokenSeconds)
	if err != nil {
		return AgoraGrant{}, fmt.Errorf("%w: %v", ErrVoiceUnavailable, err)
	}

	s.mu.Lock()
	s.pruneGrantsLocked(nowMs)
	s.grants[grantKey(channel, uid)] = &activeGrant{
		kind:    "agora",
		creds:   creds,
		expires: nowMs + int64(s.tokenSeconds)*1000,
		phase:   grantIssued,
	}
	s.mu.Unlock()

	return AgoraGrant{
		AppID:   creds.AppID,
		Channel: channel,
		UID:     uid,
		Token:   token,
	}, nil
}

// GrantRenew renews an existing voice grant and re-signs a fresh AccessToken2.
func (s *Service) GrantRenew(ctx context.Context, req VoiceGrantRenew) (AgoraGrant, error) {
	if err := ctx.Err(); err != nil {
		return AgoraGrant{}, err
	}
	key := grantKey(req.Channel, req.UID)
	nowMs := s.clock.NowMs()

	s.mu.Lock()
	s.pruneGrantsLocked(nowMs)
	g, ok := s.grants[key]
	if !ok {
		s.mu.Unlock()
		return AgoraGrant{}, fmt.Errorf("%w: voice grant expired or missing", ErrVoiceUnavailable)
	}
	if g.kind == "moss" {
		g.expires = nowMs + int64(s.tokenSeconds)*1000
		s.mu.Unlock()
		return AgoraGrant{AppID: "moss", Channel: req.Channel, UID: req.UID, Token: "moss"}, nil
	}
	creds := g.creds
	s.mu.Unlock()

	issueTs := uint32(s.clock.Now().Unix())
	token, err := BuildTokenWithRTMAt(creds.AppID, creds.AppCertificate, req.Channel, req.UID, RolePublisher, issueTs, s.tokenSeconds, s.tokenSeconds)
	if err != nil {
		return AgoraGrant{}, fmt.Errorf("%w: %v", ErrVoiceUnavailable, err)
	}

	s.mu.Lock()
	if cur, exists := s.grants[key]; exists {
		cur.expires = s.clock.NowMs() + int64(s.tokenSeconds)*1000
	}
	s.mu.Unlock()

	return AgoraGrant{
		AppID:   creds.AppID,
		Channel: req.Channel,
		UID:     req.UID,
		Token:   token,
	}, nil
}

// CallStart joins an Agora Conversational AI agent or activates a MOSS voice call for an issued grant.
func (s *Service) CallStart(ctx context.Context, req VoiceCallStart) (VoiceCall, error) {
	if err := ctx.Err(); err != nil {
		return VoiceCall{}, err
	}
	key := grantKey(req.Channel, req.UID)
	nowMs := s.clock.NowMs()

	s.mu.Lock()
	s.pruneGrantsLocked(nowMs)
	g, ok := s.grants[key]
	if !ok {
		s.mu.Unlock()
		return VoiceCall{}, fmt.Errorf("%w: voice grant expired or missing", ErrVoiceUnavailable)
	}
	if g.phase != grantIssued {
		s.mu.Unlock()
		return VoiceCall{}, fmt.Errorf("%w: call already connecting or active", ErrVoiceUnavailable)
	}
	g.phase = grantStarting
	kind := g.kind
	creds := g.creds
	s.setCallStateLocked(CallConnecting, "")
	s.mu.Unlock()

	cfg := s.voiceConfigFn()
	greeting := strings.TrimSpace(cfg.Greeting)
	if strings.TrimSpace(req.About) != "" {
		greeting = ""
	}

	if kind == "moss" {
		agentID := "moss-" + req.Channel
		s.mu.Lock()
		g.phase = grantActive
		g.agentID = agentID
		s.calls[agentID] = &activeCall{
			kind:     "moss",
			grantKey: key,
			agentID:  agentID,
			greeting: greeting,
			quick:    true,
		}
		s.setCallStateLocked(CallLive, "")
		s.mu.Unlock()
		return VoiceCall{AgentID: agentID}, nil
	}

	agentID, err := s.joinAgoraAgent(ctx, creds, cfg, req.Channel, req.UID, greeting)
	if err != nil {
		s.mu.Lock()
		if cur, exists := s.grants[key]; exists && cur == g {
			delete(s.grants, key)
		}
		s.setCallStateLocked(CallError, err.Error())
		s.mu.Unlock()
		return VoiceCall{}, fmt.Errorf("%w: %v", ErrVoiceCallFailed, err)
	}

	s.mu.Lock()
	g.phase = grantActive
	g.agentID = agentID
	s.calls[agentID] = &activeCall{
		kind:     "agora",
		grantKey: key,
		agentID:  agentID,
		creds:    creds,
		greeting: greeting,
		quick:    cfg.AnswerVendor != "orchestrator",
	}
	s.setCallStateLocked(CallLive, "")
	s.mu.Unlock()

	return VoiceCall{AgentID: agentID}, nil
}

// CallStop ends an active call and removes its grant, treating 404/already-stopping from Agora as success.
func (s *Service) CallStop(ctx context.Context, req VoiceCall) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	call := s.calls[req.AgentID]
	if call != nil {
		s.setCallStateLocked(CallEnding, "")
	}
	s.mu.Unlock()

	if call != nil && call.kind == "moss" {
		s.mu.Lock()
		delete(s.grants, call.grantKey)
		delete(s.calls, req.AgentID)
		if len(s.calls) == 0 {
			s.setCallStateLocked(CallIdle, "")
		}
		s.mu.Unlock()
		return nil
	}
	if call == nil && strings.HasPrefix(req.AgentID, "moss-") {
		return nil
	}

	var creds AgoraCredentials
	if call != nil {
		creds = call.creds
	} else {
		var err error
		creds, err = s.requireAgoraCreds()
		if err != nil {
			return err
		}
	}

	stopErr := s.leaveAgoraAgent(ctx, creds, req.AgentID)

	s.mu.Lock()
	if call != nil {
		delete(s.grants, call.grantKey)
	}
	delete(s.calls, req.AgentID)
	if len(s.calls) == 0 {
		if stopErr != nil {
			s.setCallStateLocked(CallError, stopErr.Error())
		} else {
			s.setCallStateLocked(CallIdle, "")
		}
	}
	s.mu.Unlock()
	return stopErr
}

// CallHear records user speech heard on a specific live call.
func (s *Service) CallHear(ctx context.Context, req VoiceHeard) error {
	s.mu.Lock()
	call := s.calls[req.AgentID]
	s.mu.Unlock()
	if call == nil {
		return fmt.Errorf("%w: call hung up or unknown agentId %q", ErrVoiceCallFailed, req.AgentID)
	}
	if !call.quick {
		return nil
	}
	if s.onHear != nil {
		return s.onHear(ctx, req)
	}
	return nil
}

// Hear delivers user speech to the single currently active call (refuses when 0 or >1 calls are live).
func (s *Service) Hear(ctx context.Context, text, agent, sendKey string) error {
	s.mu.Lock()
	var liveIDs []string
	for id := range s.calls {
		liveIDs = append(liveIDs, id)
	}
	s.mu.Unlock()

	if len(liveIDs) == 0 {
		return fmt.Errorf("%w: no active call", ErrVoiceCallFailed)
	}
	if len(liveIDs) > 1 {
		return fmt.Errorf("%w: multiple active calls", ErrVoiceCallFailed)
	}
	return s.CallHear(ctx, VoiceHeard{
		AgentID: liveIDs[0],
		Text:    text,
		Agent:   agent,
		SendKey: sendKey,
	})
}

// CallSay records spoken orchestrator output on an active call (suppressing repeated greeting lines).
func (s *Service) CallSay(ctx context.Context, req VoiceSaid) error {
	s.mu.Lock()
	call := s.calls[req.AgentID]
	s.mu.Unlock()
	if call == nil {
		return fmt.Errorf("%w: call hung up or unknown agentId %q", ErrVoiceCallFailed, req.AgentID)
	}
	if call.quick && strings.TrimSpace(req.Text) != call.greeting {
		if s.onSay != nil {
			return s.onSay(ctx, req)
		}
	}
	return nil
}

// Dictate validates base64 audio and sends a multipart transcription request to the configured dictation endpoint.
func (s *Service) Dictate(ctx context.Context, req DictateRequest) (Dictated, error) {
	if err := ctx.Err(); err != nil {
		return Dictated{}, err
	}
	if s.dictationCfgFn == nil {
		return Dictated{}, fmt.Errorf("%w: dictation endpoint is not configured", ErrVoiceUnavailable)
	}
	target, ok := s.dictationCfgFn()
	if !ok || strings.TrimSpace(target.URL) == "" || strings.TrimSpace(target.Key) == "" {
		return Dictated{}, fmt.Errorf("%w: dictation endpoint or key is missing", ErrVoiceUnavailable)
	}

	fmtNorm := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(req.Format), "."))
	filename, ok := supportedDictationFormats[fmtNorm]
	if !ok {
		return Dictated{}, fmt.Errorf("%w: unsupported audio format %q", ErrVoiceRefused, req.Format)
	}
	rawStr := strings.TrimSpace(req.Audio)
	if rawStr == "" {
		return Dictated{}, fmt.Errorf("%w: audio payload is empty", ErrVoiceRefused)
	}
	audioBytes, err := base64.StdEncoding.DecodeString(rawStr)
	if err != nil {
		audioBytes, err = base64.RawStdEncoding.DecodeString(rawStr)
		if err != nil {
			return Dictated{}, fmt.Errorf("%w: invalid base64 audio: %v", ErrVoiceRefused, err)
		}
	}
	if len(audioBytes) == 0 {
		return Dictated{}, fmt.Errorf("%w: audio payload is empty", ErrVoiceRefused)
	}
	if len(audioBytes) > maxDictationAudioBytes {
		return Dictated{}, fmt.Errorf("%w: audio exceeds max size", ErrVoiceRefused)
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return Dictated{}, err
	}
	if _, err := part.Write(audioBytes); err != nil {
		return Dictated{}, err
	}
	model := strings.TrimSpace(target.Model)
	if model == "" {
		model = "whisper-1"
	}
	if err := mw.WriteField("model", model); err != nil {
		return Dictated{}, err
	}
	if err := mw.Close(); err != nil {
		return Dictated{}, err
	}

	endpoint := strings.TrimRight(strings.TrimSpace(target.URL), "/")
	if !strings.HasSuffix(endpoint, "/audio/transcriptions") {
		endpoint += "/audio/transcriptions"
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return Dictated{}, err
	}
	httpReq.Header.Set("Content-Type", mw.FormDataContentType())
	httpReq.Header.Set("Authorization", "Bearer "+target.Key)
	httpReq.Header.Set("Accept", "application/json")

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return Dictated{}, fmt.Errorf("%w: dictation unreachable: %v", ErrVoiceUnavailable, err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Dictated{}, fmt.Errorf("%w: read dictation response: %v", ErrVoiceUnavailable, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Dictated{}, fmt.Errorf("%w: dictation HTTP %d", ErrVoiceUnavailable, resp.StatusCode)
	}
	var decoded struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(respBytes, &decoded); err != nil {
		return Dictated{}, fmt.Errorf("%w: invalid dictation response JSON", ErrVoiceUnavailable)
	}
	return Dictated{Text: decoded.Text}, nil
}

// MossVerify checks whether the configured MOSS Live key is accepted (redacting the key from any error text).
func (s *Service) MossVerify(ctx context.Context) Validation {
	if s.mossKeyFn == nil {
		return Validation{Problem: "MOSS Live key is not configured"}
	}
	key, ok := s.mossKeyFn()
	if !ok || strings.TrimSpace(key) == "" {
		return Validation{Problem: "MOSS Live key is not configured"}
	}
	if s.mossVerifyHook != nil {
		return s.mossVerifyHook(ctx, key)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, s.mossStatusURL, nil)
	if err != nil {
		return Validation{Problem: redactKey(err.Error(), key)}
	}
	httpReq.Header.Set("Authorization", "Bearer "+key)

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return Validation{Problem: "MOSS Live unreachable: " + redactKey(err.Error(), key)}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return Validation{Problem: "MOSS Live key refused: " + redactKey(strings.TrimSpace(string(body)), key)}
	}
	if resp.StatusCode >= 400 {
		return Validation{Problem: fmt.Sprintf("MOSS Live HTTP %d: %s", resp.StatusCode, redactKey(strings.TrimSpace(string(body)), key))}
	}
	return Validation{}
}

// SpeakPieces splits text into UTF-8 chunks of at most maxBytes (default 480) on sentence boundaries.
func SpeakPieces(text string, maxBytes int) []string {
	if maxBytes <= 0 {
		maxBytes = maxSpeakPieceBytes
	}
	rest := strings.TrimSpace(text)
	var out []string
	for rest != "" {
		if len(rest) <= maxBytes {
			out = append(out, rest)
			break
		}
		fitBytes := 0
		lastPunctEnd := -1
		for idx, r := range rest {
			rLen := utf8.RuneLen(r)
			if idx+rLen > maxBytes {
				break
			}
			fitBytes = idx + rLen
			if strings.ContainsRune("。！？!?；;\n", r) {
				lastPunctEnd = fitBytes
			}
		}
		if fitBytes == 0 {
			_, rLen := utf8.DecodeRuneInString(rest)
			fitBytes = rLen
		}
		cut := fitBytes
		if lastPunctEnd > 0 {
			cut = lastPunctEnd
		}
		piece := strings.TrimSpace(rest[:cut])
		if piece != "" {
			out = append(out, piece)
		}
		rest = strings.TrimSpace(rest[cut:])
	}
	return out
}

func (s *Service) joinAgoraAgent(ctx context.Context, creds AgoraCredentials, cfg VoiceConfigSnapshot, channel, uid, greeting string) (string, error) {
	base := s.agoraAreaURL(cfg.Area)
	endpoint := fmt.Sprintf("%s/api/conversational-ai-agent/v2/projects/%s/join", base, url.PathEscape(creds.AppID))

	idle := cfg.IdleSeconds
	if idle <= 0 {
		idle = 30
	}
	issueTs := uint32(s.clock.Now().Unix())
	agentToken, err := BuildTokenWithRTMAt(creds.AppID, creds.AppCertificate, channel, VoiceAgentUID, RolePublisher, issueTs, s.tokenSeconds, s.tokenSeconds)
	if err != nil {
		return "", err
	}

	payload := map[string]any{
		"name": channel,
		"properties": map[string]any{
			"channel":         channel,
			"token":           agentToken,
			"agent_rtc_uid":   VoiceAgentUID,
			"remote_rtc_uids": []string{uid},
			"idle_timeout":    idle,
			"advanced_features": map[string]any{
				"enable_rtm":   false,
				"enable_tools": true,
			},
			"parameters": map[string]any{
				"audio_scenario":       "chorus",
				"data_channel":         "datastream",
				"enable_error_message": true,
				"enable_metrics":       true,
			},
			"llm": map[string]any{
				"greeting_message": greeting,
				"failure_message":  cfg.FailureMessage,
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if creds.CustomerID != "" || creds.CustomerSecret != "" {
		req.SetBasicAuth(creds.CustomerID, creds.CustomerSecret)
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("agora join HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var decoded struct {
		AgentID string `json:"agent_id"`
	}
	if err := json.Unmarshal(respBody, &decoded); err != nil || strings.TrimSpace(decoded.AgentID) == "" {
		return "", errors.New("agora join response missing agent_id")
	}
	return decoded.AgentID, nil
}

func (s *Service) leaveAgoraAgent(ctx context.Context, creds AgoraCredentials, agentID string) error {
	base := s.agoraAreaURL(creds.Area)
	endpoint := fmt.Sprintf("%s/api/conversational-ai-agent/v2/projects/%s/agents/%s/leave", base, url.PathEscape(creds.AppID), url.PathEscape(agentID))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	if creds.CustomerID != "" || creds.CustomerSecret != "" {
		req.SetBasicAuth(creds.CustomerID, creds.CustomerSecret)
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrVoiceCallFailed, err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	bodyText := strings.ToLower(string(bodyBytes))
	if resp.StatusCode == http.StatusNotFound || strings.Contains(bodyText, "already in the process of shutting down") {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w: agora leave HTTP %d", ErrVoiceCallFailed, resp.StatusCode)
	}
	return nil
}

func (s *Service) agoraAreaURL(area string) string {
	key := strings.ToUpper(strings.TrimSpace(area))
	if u, ok := s.agoraBaseURLs[key]; ok {
		return u
	}
	return s.agoraBaseURLs["US"]
}

func (s *Service) requireAgoraCreds() (AgoraCredentials, error) {
	if s.agoraCredsFn == nil {
		return AgoraCredentials{}, fmt.Errorf("%w: agora credentials not configured", ErrVoiceUnavailable)
	}
	creds, ok := s.agoraCredsFn()
	if !ok || !agoraHex32Re.MatchString(creds.AppID) || !agoraHex32Re.MatchString(creds.AppCertificate) {
		return AgoraCredentials{}, fmt.Errorf("%w: invalid or missing agora credentials", ErrVoiceUnavailable)
	}
	return creds, nil
}

func (s *Service) pruneGrantsLocked(nowMs int64) {
	for k, g := range s.grants {
		if g.phase == grantIssued && g.expires <= nowMs {
			delete(s.grants, k)
		}
	}
}

func (s *Service) setCallStateLocked(state CallState, reason string) {
	s.callState = FactCallChanged{
		Type:   "callChanged",
		At:     s.clock.NowMs(),
		State:  state,
		Reason: reason,
	}
	if s.onStateChanged != nil {
		s.onStateChanged(s.callState)
	}
}

func grantKey(channel, uid string) string {
	return channel + "\x00" + uid
}

func redactKey(text, key string) string {
	if key == "" {
		return text
	}
	out := strings.ReplaceAll(text, key, "[redacted]")
	if len(out) > 200 {
		return out[:200]
	}
	return out
}

func newChannelName(nowMs int64) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	var suffix [6]byte
	for i := range suffix {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			suffix[i] = 'a'
			continue
		}
		suffix[i] = alphabet[n.Int64()]
	}
	return fmt.Sprintf("vibevalley-%d-%s", nowMs, string(suffix[:]))
}

func newNumericUID() string {
	n, err := rand.Int(rand.Reader, big.NewInt(9_999_000))
	if err != nil {
		return "1000"
	}
	return fmt.Sprintf("%d", n.Int64()+1000)
}
