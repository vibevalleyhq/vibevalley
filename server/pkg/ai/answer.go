package ai

// Every provider goes through Answer, so the order of events is the same whoever answers.

import (
	"sort"
	"strconv"
	"time"
)

type RawUsage struct {
	Input      int
	Output     int
	CacheRead  int
	CacheWrite int
	Reasoning  *int
}

type answerCall struct {
	index int
	args  string
}

// Not safe for concurrent use.
type Answer struct {
	model      Model
	responseID string
	content    []Content
	started    int64
	// -1 for none.
	open int
	// By the provider's slot: OpenAI numbers them.
	calls map[int]*answerCall
}

func NewAnswer(model Model, responseID string) *Answer {
	return &Answer{model: model, responseID: responseID, started: time.Now().UnixMilli(), open: -1, calls: map[int]*answerCall{}}
}

func (a *Answer) Partial() AssistantMessage {
	return AssistantMessage{
		Content:    append([]Content{}, a.content...),
		API:        a.model.API,
		Provider:   a.model.Provider,
		Model:      a.model.ID,
		ResponseID: a.responseID,
		Usage:      EmptyUsage(),
		StopReason: StopStop,
		Timestamp:  a.started,
	}
}

func (a *Answer) Start() []AssistantMessageEvent {
	return []AssistantMessageEvent{{Type: EventStart, Partial: a.Partial()}}
}

func (a *Answer) Thinking(delta string) []AssistantMessageEvent { return a.grow(TypeThinking, delta) }

func (a *Answer) Text(delta string) []AssistantMessageEvent { return a.grow(TypeText, delta) }

func (a *Answer) Split() []AssistantMessageEvent { return a.close() }

// Some providers want it back (Anthropic).
func (a *Answer) ThinkingSignature(signature string) []AssistantMessageEvent {
	var out []AssistantMessageEvent
	if a.open < 0 || a.content[a.open].Type != TypeThinking {
		out = append(out, a.close()...)
		a.content = append(a.content, NewThinking(""))
		a.open = len(a.content) - 1
		out = append(out, AssistantMessageEvent{Type: EventThinkingStart, ContentIndex: a.open, Partial: a.Partial()})
	}
	a.content[a.open].ThinkingSignature += signature
	return out
}

// Its data is kept as the signature.
func (a *Answer) RedactedThinking(data string) []AssistantMessageEvent {
	out := a.close()
	a.content = append(a.content, Content{Type: TypeThinking, Redacted: true, ThinkingSignature: data})
	index := len(a.content) - 1
	out = append(out,
		AssistantMessageEvent{Type: EventThinkingStart, ContentIndex: index, Partial: a.Partial()},
		AssistantMessageEvent{Type: EventThinkingEnd, ContentIndex: index, Content: "", Partial: a.Partial()},
	)
	return out
}

type ToolCallPiece struct {
	ID   string
	Name string
	Args string
}

func (a *Answer) ToolCall(slot int, piece ToolCallPiece) []AssistantMessageEvent {
	var out []AssistantMessageEvent
	call, ok := a.calls[slot]
	if !ok {
		out = append(out, a.close()...)
		id := piece.ID
		if id == "" {
			id = "call_" + strconv.Itoa(slot) + "_" + strconv.FormatInt(a.started, 36)
		}
		a.content = append(a.content, NewToolCall(id, piece.Name, []byte("{}")))
		call = &answerCall{index: len(a.content) - 1}
		a.calls[slot] = call
		out = append(out, AssistantMessageEvent{Type: EventToolCallStart, ContentIndex: call.index, Partial: a.Partial()})
	} else if piece.Name != "" && a.content[call.index].Name == "" {
		a.content[call.index].Name = piece.Name
	}
	if piece.Args != "" {
		call.args += piece.Args
		a.content[call.index].Arguments = ParseStreamingJSON(call.args)
		out = append(out, AssistantMessageEvent{Type: EventToolCallDelta, ContentIndex: call.index, Delta: piece.Args, Partial: a.Partial()})
	}
	return out
}

// A tool call makes stop into toolUse.
func (a *Answer) Done(reason StopReason, usage RawUsage) []AssistantMessageEvent {
	calls := len(a.calls)
	out := a.closeAll()
	stop := reason
	if reason == StopStop && calls > 0 {
		stop = StopToolUse
	}
	return append(out, AssistantMessageEvent{Type: EventDone, Reason: stop, Message: a.final(stop, usage, "")})
}

func (a *Answer) Error(reason StopReason, message string, usage RawUsage) []AssistantMessageEvent {
	out := a.closeAll()
	return append(out, AssistantMessageEvent{Type: EventError, Reason: reason, Error: a.final(reason, usage, message)})
}

func (a *Answer) final(stop StopReason, usage RawUsage, errorMessage string) AssistantMessage {
	m := a.Partial()
	m.Usage = Usage{
		Input: usage.Input, Output: usage.Output, CacheRead: usage.CacheRead, CacheWrite: usage.CacheWrite, Reasoning: usage.Reasoning,
		TotalTokens: usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite,
		Cost:        CalculateCost(a.model, usage),
	}
	m.StopReason = stop
	duration := time.Now().UnixMilli() - a.started
	m.DurationMs = &duration
	m.ErrorMessage = errorMessage
	return m
}

func (a *Answer) grow(kind, delta string) []AssistantMessageEvent {
	if delta == "" {
		return nil
	}
	var out []AssistantMessageEvent
	if a.open < 0 || a.content[a.open].Type != kind {
		out = append(out, a.close()...)
		a.content = append(a.content, Content{Type: kind})
		a.open = len(a.content) - 1
		start := EventTextStart
		if kind == TypeThinking {
			start = EventThinkingStart
		}
		out = append(out, AssistantMessageEvent{Type: start, ContentIndex: a.open, Partial: a.Partial()})
	}
	index := a.open
	event := EventTextDelta
	if kind == TypeText {
		a.content[index].Text += delta
	} else {
		a.content[index].Thinking += delta
		event = EventThinkingDelta
	}
	return append(out, AssistantMessageEvent{Type: event, ContentIndex: index, Delta: delta, Partial: a.Partial()})
}

func (a *Answer) close() []AssistantMessageEvent {
	if a.open < 0 {
		return nil
	}
	index := a.open
	a.open = -1
	block := a.content[index]
	switch block.Type {
	case TypeText:
		return []AssistantMessageEvent{{Type: EventTextEnd, ContentIndex: index, Content: block.Text, Partial: a.Partial()}}
	case TypeThinking:
		return []AssistantMessageEvent{{Type: EventThinkingEnd, ContentIndex: index, Content: block.Thinking, Partial: a.Partial()}}
	}
	return nil
}

// The open words, then each tool call in the order it began.
func (a *Answer) closeAll() []AssistantMessageEvent {
	out := a.close()
	calls := make([]*answerCall, 0, len(a.calls))
	for _, c := range a.calls {
		calls = append(calls, c)
	}
	sort.Slice(calls, func(i, j int) bool { return calls[i].index < calls[j].index })
	for _, call := range calls {
		a.content[call.index].Arguments = WithoutNulls(ParseToolArguments(call.args))
		out = append(out, AssistantMessageEvent{Type: EventToolCallEnd, ContentIndex: call.index, ToolCall: a.content[call.index], Partial: a.Partial()})
	}
	a.calls = map[int]*answerCall{}
	return out
}
