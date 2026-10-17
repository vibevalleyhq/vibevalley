// Package agora follows Agora's official agent quickstart. Which vendors the agent uses, and what it is told, is the caller's.
package agora

import (
	"context"
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

type Credentials struct {
	AppID          string
	AppCertificate string
}

// A page renews tokens before they run out.
const TokenSeconds = 3600

// RTM must log in as uid (quickstart: generate-agora-token).
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

// prefix-<ms>-<6 random>: the quickstart's timestamp-plus-random shape.
func NewChannel(prefix string) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var b strings.Builder
	for range 6 {
		b.WriteByte(digits[random(36)])
	}
	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixMilli(), b.String())
}

func NewUID() string { return fmt.Sprint(random(9_999_000) + 1000) }

// httpClient nil is agentkit's own.
type Client struct{ client *agentkit.AgoraClient }

func NewClient(c Credentials, area option.Area, httpClient sdkcore.HTTPClient) *Client {
	return &Client{client: agentkit.NewAgoraClient(agentkit.AgoraClientOptions{Area: area, AppID: c.AppID, AppCertificate: c.AppCertificate, HTTPClient: httpClient})}
}

type Session struct {
	Name, Channel, AgentUID, UID string
	IdleSeconds                  int
}

func (c *Client) Start(ctx context.Context, a Agent, v Vendors, s Session) (string, error) {
	session := newAgent(c.client, a, v).CreateSession(agentkit.CreateSessionOptions{
		Name: s.Name, Channel: s.Channel, AgentUID: s.AgentUID, RemoteUIDs: []string{s.UID}, IdleTimeout: &s.IdleSeconds, ExpiresIn: TokenSeconds,
	})
	return session.Start(ctx)
}

func (c *Client) Stop(ctx context.Context, id string) error {
	err := c.client.StopAgent(ctx, id)
	if err == nil || alreadyStopping(err) {
		return nil
	}
	return err
}

type Vendors struct {
	STT agentcore.STTVendor
	LLM agentcore.LLMVendor
	TTS agentcore.TTSVendor
}

func SpeakingLLM(o vendors.OpenAIOptions, greeting, failure string) *vendors.OpenAI {
	maxHistory := 15
	o.GreetingMessage, o.FailureMessage = greeting, failure
	o.MaxHistory = &maxHistory
	o.Params = map[string]any{"max_tokens": 512, "temperature": 0.7, "top_p": 0.95}
	return vendors.NewOpenAI(o)
}

type Captions string

const (
	CaptionsRTM        Captions = "rtm"
	CaptionsDataStream Captions = "datastream"
)

type Agent struct {
	// BCP 47: zh-CN.
	Language               string
	Persona                string
	InterruptMs, SilenceMs int64
	// Empty is RTM.
	Captions Captions
}

func newAgent(client *agentkit.AgoraClient, a Agent, v Vendors) *agentkit.Agent {
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
	// RTM carries transcripts, agent state, metrics and errors to the client; both flags are required. A client without
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

// agentkit's shapes are the REST API's, so they are written here as the API's JSON.
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

// Already left or leaving counts as success, as the quickstart treats it. agentkit answers 404 as success itself; the "already shutting down" text
// arrives in the error's body.
func alreadyStopping(err error) bool {
	var api *sdkcore.APIError
	if errors.As(err, &api) && api.StatusCode == http.StatusNotFound {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "already in the process of shutting down")
}
