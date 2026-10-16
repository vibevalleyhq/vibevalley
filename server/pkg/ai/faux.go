package ai

// Named as pi-ai's faux provider. Delay lets a test stop an answer halfway.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

func FauxText(text string) Content { return NewText(text) }

func FauxThinking(thinking string) Content { return NewThinking(thinking) }

var fauxCalls atomic.Int64

// arguments is JSON text (string, []byte, json.RawMessage), kept in its order, or a value to marshal; id "" makes one up.
func FauxToolCall(name string, arguments any, id string) Content {
	if id == "" {
		id = fmt.Sprintf("faux_call_%d", fauxCalls.Add(1))
	}
	var raw json.RawMessage
	switch a := arguments.(type) {
	case nil:
		raw = json.RawMessage("{}")
	case string:
		raw = json.RawMessage(a)
	case []byte:
		raw = json.RawMessage(a)
	case json.RawMessage:
		raw = a
	default:
		raw = marshal(a)
	}
	if compact := compactObject(raw); compact != nil {
		raw = compact
	}
	return NewToolCall(id, name, raw)
}

type FauxOptions struct {
	StopReason   StopReason
	ErrorMessage string
}

func FauxAssistantMessage(content any, options ...FauxOptions) AssistantMessage {
	var blocks []Content
	switch c := content.(type) {
	case string:
		blocks = []Content{FauxText(c)}
	case Content:
		blocks = []Content{c}
	case []Content:
		blocks = append([]Content{}, c...)
	default:
		panic(fmt.Sprintf("FauxAssistantMessage: content of type %T", content))
	}
	var o FauxOptions
	if len(options) > 0 {
		o = options[0]
	}
	stop := o.StopReason
	if stop == "" {
		stop = StopStop
		for _, b := range blocks {
			if b.Type == TypeToolCall {
				stop = StopToolUse
			}
		}
	}
	return AssistantMessage{
		Content: blocks, API: "faux", Provider: "faux", Model: "faux-1", Usage: EmptyUsage(),
		StopReason: stop, ErrorMessage: o.ErrorMessage, Timestamp: time.Now().UnixMilli(),
	}
}

type FauxProviderState struct {
	CallCount int
	Contexts  []Context
}

type FauxResponseFactory func(c Context, options StreamOptions, state FauxProviderState, model Model) AssistantMessage

// An AssistantMessage or a FauxResponseFactory (or a func of that shape).
type FauxResponseStep = any

type FauxModelDefinition struct {
	ID            string
	Name          string
	Reasoning     bool
	ContextWindow int
	MaxTokens     int
}

type FauxProviderOptions struct {
	API      string
	Provider string
	Models   []FauxModelDefinition
	// 4 when 0.
	ChunkSize int
	Delay     time.Duration
}

type FauxProviderHandle struct {
	API      string
	Provider ApiProvider
	Models   []Model

	mu    sync.Mutex
	queue []FauxResponseStep
	state FauxProviderState
}

func chunks(text string, size int) []string {
	r := []rune(text)
	var out []string
	for i := 0; i < len(r); i += size {
		out = append(out, string(r[i:min(len(r), i+size)]))
	}
	return out
}

func Replay(model Model, message AssistantMessage, chunkSize int) []AssistantMessageEvent {
	if chunkSize <= 0 {
		chunkSize = 4
	}
	answer := NewAnswer(model, "")
	out := answer.Start()
	said := ""
	for slot, block := range message.Content {
		switch block.Type {
		case TypeText:
			for _, c := range chunks(block.Text, chunkSize) {
				out = append(out, answer.Text(c)...)
			}
			said += block.Text
		case TypeThinking:
			for _, c := range chunks(block.Thinking, chunkSize) {
				out = append(out, answer.Thinking(c)...)
			}
			said += block.Thinking
		default:
			out = append(out, answer.ToolCall(slot, ToolCallPiece{ID: block.ID, Name: block.Name})...)
			args := string(block.Args())
			for _, c := range chunks(args, chunkSize*4) {
				out = append(out, answer.ToolCall(slot, ToolCallPiece{Args: c})...)
			}
			said += args
		}
	}
	usage := RawUsage{Output: int(math.Ceil(float64(len([]rune(said))) / 4))}
	if message.Usage.TotalTokens != 0 {
		u := message.Usage
		usage = RawUsage{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite, Reasoning: u.Reasoning}
	}
	if message.StopReason == StopError || message.StopReason == StopAborted {
		why := message.ErrorMessage
		if why == "" {
			why = "出错了"
		}
		return append(out, answer.Error(message.StopReason, why, usage)...)
	}
	return append(out, answer.Done(message.StopReason, usage)...)
}

func FauxProvider(options FauxProviderOptions) *FauxProviderHandle {
	api := options.API
	if api == "" {
		api = "faux"
	}
	providerName := options.Provider
	if providerName == "" {
		providerName = "faux"
	}
	definitions := options.Models
	if len(definitions) == 0 {
		definitions = []FauxModelDefinition{{ID: "faux-1"}}
	}
	h := &FauxProviderHandle{API: api}
	for _, d := range definitions {
		name := d.Name
		if name == "" {
			name = d.ID
		}
		window := d.ContextWindow
		if window == 0 {
			window = 128_000
		}
		maxTokens := d.MaxTokens
		if maxTokens == 0 {
			maxTokens = 16_000
		}
		h.Models = append(h.Models, Model{
			ID: d.ID, Name: name, API: api, Provider: providerName, BaseURL: "faux://", Reasoning: d.Reasoning,
			Input: []string{"text", "image"}, ContextWindow: window, MaxTokens: maxTokens,
		})
	}
	h.Provider = ApiProvider{API: api, Stream: func(ctx context.Context, model Model, c Context, streamOptions StreamOptions) <-chan AssistantMessageEvent {
		h.mu.Lock()
		h.state.CallCount++
		h.state.Contexts = append(h.state.Contexts, c)
		var step FauxResponseStep
		if len(h.queue) > 0 {
			step = h.queue[0]
			h.queue = h.queue[1:]
		}
		state := h.snapshotLocked()
		h.mu.Unlock()
		var message AssistantMessage
		switch s := step.(type) {
		case nil:
			return FromEvents(ctx, NewAnswer(model, "").Error(StopError, "faux：剧本里没有下一步了", RawUsage{}))
		case AssistantMessage:
			message = s
		case FauxResponseFactory:
			message = s(c, streamOptions, state, model)
		case func(Context, StreamOptions, FauxProviderState, Model) AssistantMessage:
			message = s(c, streamOptions, state, model)
		default:
			return FromEvents(ctx, NewAnswer(model, "").Error(StopError, fmt.Sprintf("faux：剧本里的一步是 %T", step), RawUsage{}))
		}
		events := Replay(model, message, options.ChunkSize)
		if options.Delay <= 0 {
			return FromEvents(ctx, events)
		}
		out := make(chan AssistantMessageEvent)
		go func() {
			defer close(out)
			for _, e := range events {
				if !send(ctx, out, e) {
					return
				}
				select {
				case <-time.After(options.Delay):
				case <-ctx.Done():
					return
				}
			}
		}()
		return out
	}}
	return h
}

func (h *FauxProviderHandle) GetModel(id ...string) Model {
	if len(id) == 0 {
		return h.Models[0]
	}
	for _, m := range h.Models {
		if m.ID == id[0] {
			return m
		}
	}
	return Model{}
}

func (h *FauxProviderHandle) snapshotLocked() FauxProviderState {
	return FauxProviderState{CallCount: h.state.CallCount, Contexts: append([]Context(nil), h.state.Contexts...)}
}

func (h *FauxProviderHandle) State() FauxProviderState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.snapshotLocked()
}

func (h *FauxProviderHandle) SetResponses(responses ...FauxResponseStep) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.queue = append([]FauxResponseStep(nil), responses...)
}

func (h *FauxProviderHandle) AppendResponses(responses ...FauxResponseStep) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.queue = append(h.queue, responses...)
}

func (h *FauxProviderHandle) GetPendingResponseCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.queue)
}
