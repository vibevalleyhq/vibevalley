package acp

import (
	"encoding/json"
	"errors"
	"net/url"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// The turn machinery (turns.ts): ≤1 active turn, each `session/prompt` RPC
// of it, the host-held queue, cancel with a kill fallback. The RPC ANSWER is
// the runtime's own turn end and is recorded as a frame with a turn_ended
// event; a rejected prompt RPC is likewise the runtime's word. A refused
// steer instead drops that input and preserves the active turn's outcome.
// The process dying is not; that is the `exited` response the session
// records from its exit observer. One turn may span several prompt RPCs
// (grok's send-now steer): each answer is its own frame; the turn_ended
// event rides the final answer, carrying the latest non-refused request's
// outcome. Otherwise the original prompt's answer ends the turn
// independently of steer replies.
//
// Concurrency: every method runs with the session lock held; prompt answers
// arrive on the reader goroutine in wire order and take the lock themselves.

// ActiveTurn is the turn in progress.
type ActiveTurn struct {
	// The prompt request that opened this turn; nil for a spontaneous (queue-drained) turn.
	Request *oar.RawEvent
	// The last record before this turn: what the runtime said during it comes after.
	since          int64
	outcomes       map[int]oar.TurnOutcome
	pending        map[int]bool
	abortRequested bool
	fallback       *time.Timer
}

// TakesImages reports the agent advertised image prompts in `initialize`.
func TakesImages(initialized jsonx.Record) bool {
	return jsonx.Get(initialized, "agentCapabilities", "promptCapabilities", "image") == true
}

func fileURL(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = path
	}
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
}

// prompt is one input as ACP ContentBlocks: the images (each naming its file as `uri`), then any nonempty text.
func prompt(input string, images []kernel.LoadedImage) []any {
	blocks := []any{}
	for _, image := range images {
		blocks = append(blocks, map[string]any{"type": "image", "mimeType": image.MediaType, "data": image.Data, "uri": fileURL(image.Path)})
	}
	if input != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": input})
	}
	return blocks
}

type heldInput struct {
	inputID string
	prompt  []any
}

func (h heldInput) HeldInputID() string { return h.inputID }

// Turns is a session's turn machinery.
type Turns struct {
	lock        sync.Locker
	kernel      *kernel.Kernel
	process     *Process
	profile     Profile
	gate        *UsageGate
	images      bool
	promptMeta  jsonx.Record
	promptUsage func(response jsonx.Record) oar.EventBody
	held        []heldInput
	active      *ActiveTurn
	nextRequest int
}

// TurnsDeps is what NewTurns builds on; Lock is the session lock the
// answers take.
type TurnsDeps struct {
	Lock        sync.Locker
	Kernel      *kernel.Kernel
	Process     *Process
	Profile     Profile
	Gate        *UsageGate
	Images      bool
	PromptMeta  jsonx.Record
	PromptUsage func(response jsonx.Record) oar.EventBody
}

// NewTurns starts with no turn.
func NewTurns(deps TurnsDeps) *Turns {
	return &Turns{lock: deps.Lock, kernel: deps.Kernel, process: deps.Process, profile: deps.Profile, gate: deps.Gate, images: deps.Images, promptMeta: deps.PromptMeta, promptUsage: deps.PromptUsage}
}

// Active is the turn in progress, nil when idle.
func (t *Turns) Active() *ActiveTurn { return t.active }

func (t *Turns) closeTurn(state *ActiveTurn) {
	if state.fallback != nil {
		state.fallback.Stop()
		state.fallback = nil
	}
	if t.active == state {
		t.active = nil
	}
	t.drainHeld()
}

type answerFrame struct {
	frameType string
	native    json.RawMessage
	context   oar.EventBody
	dropped   *string
	steered   bool
}

func (t *Turns) finishRequest(state *ActiveTurn, requestNumber int, frame answerFrame, outcome *oar.TurnOutcome) {
	delete(state.pending, requestNumber)
	if outcome != nil {
		state.outcomes[requestNumber] = *outcome
	}
	closes := t.active == state && !frame.steered
	if t.profile.SteerSupersedesPrompt {
		closes = t.active == state && len(state.pending) == 0
	}
	events := []oar.EventBody{}
	if frame.dropped != nil {
		events = append(events, oar.InputDropped{InputID: *frame.dropped, Reason: "runtime_refused"})
	}
	if closes {
		terminal := outcome
		if t.profile.SteerSupersedesPrompt {
			terminal = nil
			if len(state.outcomes) > 0 {
				keys := make([]int, 0, len(state.outcomes))
				for key := range state.outcomes {
					keys = append(keys, key)
				}
				sort.Ints(keys)
				latest := state.outcomes[keys[len(keys)-1]]
				terminal = &latest
			}
		}
		if terminal != nil {
			events = append(events, oar.TurnEnded{Outcome: *terminal})
		}
	}
	if frame.context != nil {
		events = append(events, frame.context)
	}
	t.kernel.Frame(oar.FrameBody{Type: frame.frameType, Native: frame.native, Events: events}, kernel.RecordAt{})
	if closes {
		t.closeTurn(state)
	}
}

func (t *Turns) startVendorPrompt(state *ActiveTurn, blocks []any, extraParams jsonx.Record, steeredInput *string, steered bool) {
	t.nextRequest++
	requestNumber := t.nextRequest
	state.pending[requestNumber] = true
	t.gate.Arm()
	params := map[string]any{"sessionId": t.kernel.SessionID(), "prompt": blocks}
	for key, value := range extraParams {
		params[key] = value
	}
	if t.promptMeta != nil {
		meta := jsonx.Record{}
		for key, value := range t.promptMeta {
			meta[key] = value
		}
		for key, value := range jsonx.AsRecord(extraParams["_meta"]) {
			meta[key] = value
		}
		params["_meta"] = meta
	}
	err := t.process.Call(MethodSessionPrompt, params, 0, func(result json.RawMessage, err error) {
		t.answer(state, requestNumber, steeredInput, steered, result, err)
	})
	if err != nil {
		// Not the runtime's word: the exit observer records the `exited` response.
		delete(state.pending, requestNumber)
		t.closeTurn(state)
	}
}

// answer handles one prompt RPC's answer; it runs on the reader goroutine
// (or the exit path) without the session lock.
func (t *Turns) answer(state *ActiveTurn, requestNumber int, steeredInput *string, steered bool, result json.RawMessage, err error) {
	var acpErr *Error
	if errors.As(err, &acpErr) && acpErr.Kind == KindProcessExited {
		// Not the runtime's word: the exit observer records the `exited` response, the turn's end.
		t.lock.Lock()
		defer t.lock.Unlock()
		delete(state.pending, requestNumber)
		t.closeTurn(state)
		return
	}
	var response jsonx.Record
	if err == nil {
		response, err = responseRecord(MethodSessionPrompt, result)
	}
	if err != nil {
		t.lock.Lock()
		defer t.lock.Unlock()
		t.failRequest(state, requestNumber, steeredInput, steered, err)
		return
	}
	t.lock.Lock()
	// Deliberate ordering: the answer's frame waits (bounded) for the
	// usage_update kimi pushes AFTER answering, so the usage record precedes
	// the turn end and contextUsage() at turn_ended is this turn's own value.
	wait := t.gate.Settle(t.profile, state.abortRequested)
	if wait == nil {
		t.finishAnswer(state, requestNumber, steered, result, response)
		t.lock.Unlock()
		return
	}
	t.lock.Unlock()
	// The reader goes on recording (the awaited usage_update arrives on it).
	go func() {
		wait()
		t.lock.Lock()
		defer t.lock.Unlock()
		t.finishAnswer(state, requestNumber, steered, result, response)
	}()
}

func (t *Turns) finishAnswer(state *ActiveTurn, requestNumber int, steered bool, result json.RawMessage, response jsonx.Record) {
	var usage oar.EventBody
	if t.promptUsage != nil {
		usage = t.promptUsage(response)
	}
	outcome := DefaultPromptOutcome(response)
	if t.profile.PromptOutcome != nil {
		if read := t.profile.PromptOutcome(response); read != nil {
			outcome = *read
		}
	}
	t.finishRequest(state, requestNumber, answerFrame{frameType: MethodSessionPrompt, native: result, context: usage, steered: steered}, &outcome)
}

func (t *Turns) failRequest(state *ActiveTurn, requestNumber int, steeredInput *string, steered bool, err error) {
	var turnFrames []oar.FrameBody
	for _, record := range t.kernel.Records() {
		if record.Kind == oar.KindFrame && record.Seq > state.since {
			turnFrames = append(turnFrames, record.Frame)
		}
	}
	outcome := FailureOutcome(err, turnFrames, t.profile.FailureOutcome)
	if state.abortRequested {
		outcome = oar.AbortedOutcome()
	}
	frame := answerFrame{frameType: MethodSessionPrompt + "/error", native: ErrorNative(err), steered: steered}
	if steered {
		frame.dropped = steeredInput
		t.finishRequest(state, requestNumber, frame, nil)
		return
	}
	t.finishRequest(state, requestNumber, frame, &outcome)
}

func (t *Turns) gone() oar.ResponseBody {
	return oar.Rejected(oar.CodeRuntimeExited, ProcessExitedError(t.process.ExitCode()).Message)
}

func (t *Turns) open(request *oar.RawEvent, blocks []any) oar.ResponseBody {
	if t.process.Closed() {
		return t.gone()
	}
	state := &ActiveTurn{Request: request, since: int64(t.kernel.Len()) - 1, outcomes: map[int]oar.TurnOutcome{}, pending: map[int]bool{}}
	t.active = state
	t.startVendorPrompt(state, blocks, nil, nil, false)
	return oar.Accepted()
}

// Begin opens a turn with one prompt RPC; rejected when the process is gone
// or its images cannot go.
func (t *Turns) Begin(request *oar.RawEvent, input string, images []oar.InputImage) oar.ResponseBody {
	body, _ := kernel.WithInputImages(t.images, images, func(loaded []kernel.LoadedImage) (oar.ResponseBody, error) {
		return t.open(request, prompt(input, loaded)), nil
	})
	return body
}

func (t *Turns) drainHeld() {
	// Held input is dropped once the stream says the runtime is unreachable
	// (an `exited` response or a `dispose` request), not by an adapter flag.
	if t.kernel.Unreachable() != nil || t.active != nil || t.process.Closed() || len(t.held) == 0 {
		return
	}
	// Taken off `held` in the same step it is sent: a withdraw after this finds it gone.
	next := t.held[0]
	t.held = t.held[1:]
	t.open(nil, next.prompt)
}

// Steer is another prompt RPC inside the active turn (the profile's steer params); rejected like Begin.
func (t *Turns) Steer(state *ActiveTurn, input string, options oar.InputOptions, extraParams jsonx.Record) oar.ResponseBody {
	if t.process.Closed() {
		return t.gone()
	}
	body, _ := kernel.WithInputImages(t.images, options.Images, func(loaded []kernel.LoadedImage) (oar.ResponseBody, error) {
		inputID := options.InputID
		t.startVendorPrompt(state, prompt(input, loaded), extraParams, &inputID, true)
		return oar.Accepted(), nil
	})
	return body
}

// Abort sends session/cancel, then arms a bounded wait after which the process is killed.
func (t *Turns) Abort(state *ActiveTurn) oar.ResponseBody {
	if !state.abortRequested {
		state.abortRequested = true
		if err := t.process.Notify(MethodSessionCancel, map[string]any{"sessionId": t.kernel.SessionID()}); err != nil {
			return oar.Rejected(oar.CodeError, err.Error())
		}
		timeout := t.profile.AbortTimeout
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		// A runtime that never answers the cancelled prompt is killed; the
		// exit then shows up as the `exited` response, the turn's end.
		state.fallback = time.AfterFunc(timeout, func() {
			t.lock.Lock()
			defer t.lock.Unlock()
			if t.active == state {
				t.process.Kill()
			}
		})
	}
	return oar.Accepted()
}

// Hold keeps input for the next turn, drained when the active one closes
// (at once when idle); rejected like Begin.
func (t *Turns) Hold(input string, images []oar.InputImage, inputID string) oar.ResponseBody {
	if t.process.Closed() {
		return t.gone()
	}
	body, _ := kernel.WithInputImages(t.images, images, func(loaded []kernel.LoadedImage) (oar.ResponseBody, error) {
		t.held = append(t.held, heldInput{inputID: inputID, prompt: prompt(input, loaded)})
		return oar.Accepted(), nil
	})
	return body
}

// DrainHeld starts the next held input when nothing runs (TS queueMicrotask(drainHeld) after a hold).
func (t *Turns) DrainHeld() { t.drainHeld() }

// Withdraw takes a held input back by its inputId before the drain sends it.
func (t *Turns) Withdraw(inputID string) oar.ResponseBody {
	return kernel.WithdrawHeld(&t.held, inputID)
}

// OnExit closes the active turn (its end is the exited response) and drops held input.
func (t *Turns) OnExit() {
	if t.active != nil {
		t.closeTurn(t.active)
	}
	t.held = nil
}
