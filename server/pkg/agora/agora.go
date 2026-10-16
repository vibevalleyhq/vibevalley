// Package agora is what VibeValley asks of Agora, after the official agent quickstart: one RTC+RTM token per page,
// and a Conversational AI agent built with Agora's Go SDK (agentkit), asked into a channel and out again. Which
// vendors the agent uses, and what it is told, is the caller's.
package agora

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/AgoraIO-Community/go-tokenbuilder/rtctokenbuilder2"
	"github.com/AgoraIO/agora-agents-go/v2/agentkit"
	agentcore "github.com/AgoraIO/agora-agents-go/v2/agentkit/core"
	"github.com/AgoraIO/agora-agents-go/v2/agentkit/vendors"
	sdkcore "github.com/AgoraIO/agora-agents-go/v2/core"
	"github.com/AgoraIO/agora-agents-go/v2/option"
)

// Credentials are a project's App ID and App Certificate: tokens are signed with them, and agentkit builds the REST
// API's auth from them.
type Credentials struct {
	AppID          string
	AppCertificate string
}

// TokenSeconds: tokens last an hour; a page renews them before they run out.
const TokenSeconds = 3600

// Token is one token for RTC and RTM in channel; RTM must log in as uid (quickstart: generate-agora-token).
func Token(c Credentials, channel, uid string) (string, error) {
	return rtctokenbuilder2.BuildTokenWithRtm(c.AppID, c.AppCertificate, channel, uid, rtctokenbuilder2.RolePublisher, TokenSeconds, TokenSeconds)
}

func random(n int64) int64 {
	x, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		return 0
	}
	return x.Int64()
}

// NewChannel is a channel of our own, prefix-<ms>-<6 random>: the quickstart's timestamp-plus-random shape.
func NewChannel(prefix string) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var b strings.Builder
	for range 6 {
		b.WriteByte(digits[random(36)])
	}
	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixMilli(), b.String())
}

// NewUID is a random UID for a page, as the quickstart picks one.
func NewUID() string { return fmt.Sprint(random(9_999_000) + 1000) }

// NewClient is agentkit's client for the ConvoAI REST API in area; httpClient nil is agentkit's own.
func NewClient(c Credentials, area option.Area, httpClient sdkcore.HTTPClient) *agentkit.AgoraClient {
	return agentkit.NewAgoraClient(agentkit.AgoraClientOptions{Area: area, AppID: c.AppID, AppCertificate: c.AppCertificate, HTTPClient: httpClient})
}

// Vendors are an agent's three stages: hearing, thinking, speaking.
type Vendors struct {
	STT agentcore.STTVendor
	LLM agentcore.LLMVendor
	TTS agentcore.TTSVendor
}

// SpeakingLLM is an OpenAI-compatible model answering in a call: it greets, says failure when it fails, remembers the
// last 15 turns and answers short.
func SpeakingLLM(o vendors.OpenAIOptions, greeting, failure string) *vendors.OpenAI {
	maxHistory := 15
	o.GreetingMessage, o.FailureMessage = greeting, failure
	o.MaxHistory = &maxHistory
	o.Params = map[string]any{"max_tokens": 512, "temperature": 0.7, "top_p": 0.95}
	return vendors.NewOpenAI(o)
}

// Captions is how the transcripts reach the page: over RTM, or the RTC data stream.
type Captions string

const (
	CaptionsRTM        Captions = "rtm"
	CaptionsDataStream Captions = "datastream"
)

// Agent is how the agent listens and who it is.
type Agent struct {
	// Language is what the recogniser listens for (docs: ASR), as BCP 47: zh-CN.
	Language string
	// Persona is the agent's instructions.
	Persona string
	// InterruptMs is how long the person speaks over the agent before it stops; SilenceMs how long a pause ends a turn.
	InterruptMs, SilenceMs int64
	// Captions empty is RTM.
	Captions Captions
}

// NewAgent is the agent a describes, on client, with v's stages.
func NewAgent(client *agentkit.AgoraClient, a Agent, v Vendors) *agentkit.Agent {
	captions := a.Captions
	if captions == "" {
		captions = CaptionsRTM
	}
	turn := decode[agentkit.TurnDetectionConfig](map[string]any{
		"language": a.Language,
		"config": map[string]any{
			"speech_threshold": 0.5,
			"start_of_speech":  map[string]any{"mode": "vad", "vad_config": map[string]any{"interrupt_duration_ms": a.InterruptMs, "prefix_padding_ms": 300}},
			"end_of_speech":    map[string]any{"mode": "vad", "vad_config": map[string]any{"silence_duration_ms": a.SilenceMs}},
		},
	})
	// RTM carries transcripts, agent state, metrics and errors to the page; both flags are required. A client without
	// RTM asks for the RTC data stream instead, which carries the transcripts (chunked) but not the agent's state; RTM
	// is then off, or the agent keeps sending to RTM and nothing reaches the data stream.
	features := decode[agentkit.AdvancedFeatures](map[string]any{"enable_rtm": captions == CaptionsRTM, "enable_tools": true})
	params := decode[agentkit.SessionParams](map[string]any{
		"audio_scenario": "chorus", "data_channel": captions, "enable_error_message": true, "enable_metrics": true,
	})
	agent := agentkit.NewAgent(client,
		agentkit.WithInstructions(a.Persona),
		agentkit.WithMaxHistory(50),
		agentkit.WithTurnDetectionConfig(turn),
		agentkit.WithAdvancedFeatures(features),
		agentkit.WithParameters(params),
	)
	return agent.WithStt(v.STT).WithLlm(v.LLM).WithTts(v.TTS)
}

// decode is v as agentkit's T: its shapes are the REST API's, so they are written here as the API's JSON.
func decode[T any](v any) *T {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var t T
	if err := json.Unmarshal(body, &t); err != nil {
		panic(err)
	}
	return &t
}

// AlreadyStopping is whether stopping failed only because the agent already left or is leaving: success, as the
// quickstart treats it. agentkit answers 404 as success itself; the "already shutting down" text arrives in the
// error's body.
func AlreadyStopping(err error) bool {
	var api *sdkcore.APIError
	if errors.As(err, &api) && api.StatusCode == http.StatusNotFound {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "already in the process of shutting down")
}
