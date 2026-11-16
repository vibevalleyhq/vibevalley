package oar

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
)

var refusableOrder = []RefusableOption{
	OptionSystemPrompt,
	OptionAppendSystemPrompt,
	OptionEffort,
	OptionEnv,
	OptionMCPServers,
	OptionMCPServerCredentials,
	OptionDisallowedTools,
	OptionAllowedTools,
	OptionName,
	OptionServiceTier,
	OptionAdditionalDirectories,
	OptionOutputSchema,
	OptionLaunchArgs,
}

// ValidateOptions enforces a driver's static RefusedOptions before spawning any subprocess or creating temp files.
func ValidateOptions(runtimeID string, refused RefusedOptions, opts SessionOptions) error {
	if len(refused) == 0 {
		return nil
	}
	for _, opt := range refusableOrder {
		reason, denied := refused[opt]
		if !denied {
			continue
		}
		if optionProvided(opts, opt) {
			return &UnsupportedOptionError{
				Runtime: runtimeID,
				Option:  opt,
				Reason:  reason,
			}
		}
	}
	return nil
}

func optionProvided(opts SessionOptions, opt RefusableOption) bool {
	switch opt {
	case OptionSystemPrompt:
		return opts.SystemPrompt != ""
	case OptionAppendSystemPrompt:
		return opts.AppendSystemPrompt != ""
	case OptionEffort:
		return opts.Effort != ""
	case OptionEnv:
		return len(opts.Env) > 0 || len(opts.UnsetEnv) > 0
	case OptionMCPServers:
		return len(opts.MCPServers) > 0
	case OptionMCPServerCredentials:
		for _, srv := range opts.MCPServers {
			if srv.HasCredentials() {
				return true
			}
		}
		return false
	case OptionDisallowedTools:
		return len(opts.DisallowedTools) > 0
	case OptionAllowedTools:
		return len(opts.AllowedTools) > 0
	case OptionName:
		return opts.Name != ""
	case OptionServiceTier:
		return opts.ServiceTier != ""
	case OptionAdditionalDirectories:
		return len(opts.AdditionalDirectories) > 0
	case OptionOutputSchema:
		return len(opts.OutputSchema) > 0
	case OptionLaunchArgs:
		return len(opts.LaunchArgs) > 0
	default:
		return false
	}
}

func buildEnv(opts SessionOptions, forced map[string]string) []string {
	base := opts.BaseEnv
	if base == nil {
		base = os.Environ()
	}
	merged := make(map[string]string, len(base)+len(opts.Env)+len(forced))
	for _, kv := range base {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			continue
		}
		merged[k] = v
	}
	for _, k := range opts.UnsetEnv {
		delete(merged, k)
	}
	for k, v := range opts.Env {
		merged[k] = v
	}
	for k, v := range forced {
		merged[k] = v
	}
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+merged[k])
	}
	return out
}

// secretDir owns a 0700 temporary directory and 0600 files so secrets and multi-line prompts stay out of argv.
type secretDir struct {
	path      string
	closeOnce sync.Once
}

func newSecretDir(prefix string) (*secretDir, error) {
	dir, err := os.MkdirTemp("", prefix)
	if err != nil {
		return nil, fmt.Errorf("oar: create secret dir: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("oar: chmod secret dir: %w", err)
	}
	return &secretDir{path: dir}, nil
}

func (d *secretDir) writeFile(name string, data []byte) (string, error) {
	if d == nil {
		return "", errors.New("oar: nil secret dir")
	}
	target := filepath.Join(d.path, name)
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return "", fmt.Errorf("oar: write secret file %q: %w", name, err)
	}
	if err := os.Chmod(target, 0o600); err != nil {
		return "", fmt.Errorf("oar: chmod secret file %q: %w", name, err)
	}
	return target, nil
}

func (d *secretDir) close() {
	if d == nil {
		return
	}
	d.closeOnce.Do(func() {
		_ = os.RemoveAll(d.path)
	})
}

func marshalMCPConfigFile(servers []MCPServer) ([]byte, error) {
	cfg := make(map[string]any, len(servers))
	for _, s := range servers {
		switch s.Type {
		case MCPHTTP:
			entry := map[string]any{
				"type": "http",
				"url":  s.URL,
			}
			if len(s.Headers) > 0 {
				entry["headers"] = s.Headers
			}
			cfg[s.Name] = entry
		default:
			args := s.Args
			if args == nil {
				args = []string{}
			}
			entry := map[string]any{
				"command": s.Command,
				"args":    args,
			}
			if len(s.Env) > 0 {
				entry["env"] = s.Env
			}
			cfg[s.Name] = entry
		}
	}
	return json.Marshal(map[string]any{"mcpServers": cfg})
}

type queuedInput struct {
	input   string
	inputID string
	spanID  string
}

type inputQueue struct {
	mu    sync.Mutex
	items []queuedInput
}

func (q *inputQueue) push(item queuedInput) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = append(q.items, item)
}

func (q *inputQueue) pop() (queuedInput, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return queuedInput{}, false
	}
	first := q.items[0]
	q.items = q.items[1:]
	return first, true
}

func (q *inputQueue) withdraw(inputID string) bool {
	if inputID == "" {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, item := range q.items {
		if item.inputID == inputID {
			q.items = slices.Delete(q.items, i, i+1)
			return true
		}
	}
	return false
}

func (q *inputQueue) clear() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = nil
}

// recordStream stores monotonically sequenced RecordEnvelopes and delivers ordered copies to subscribers.
type recordStream struct {
	now       func() int64
	mu        sync.Mutex
	sessionID string
	nextSeq   int64
	records   []RecordEnvelope
	subs      map[uint64]*subscriber
	nextSubID uint64
	pumpWG    sync.WaitGroup
}

type subscriber struct {
	id       uint64
	stream   *recordStream
	fn       func(RecordEnvelope)
	mu       sync.Mutex
	cond     *sync.Cond
	pending  []RecordEnvelope
	stopped  bool
	replayed chan struct{}
	stopOnce sync.Once
}

func newRecordStream(initialSessionID string, now func() int64) *recordStream {
	if now == nil {
		now = func() int64 { return 0 }
	}
	return &recordStream{
		now:       now,
		sessionID: initialSessionID,
		subs:      make(map[uint64]*subscriber),
	}
}

func (s *recordStream) setSessionID(id string) {
	if id == "" {
		return
	}
	s.mu.Lock()
	s.sessionID = id
	s.mu.Unlock()
}

func (s *recordStream) sessionIDSnapshot() string {
	s.mu.Lock()
	id := s.sessionID
	s.mu.Unlock()
	return id
}

func (s *recordStream) emit(kind RecordKind, spanID string, agentPath []string, frameType string, raw []byte, events []Event, ctrl *ControlTrace, marker *MarkerRecord) RecordEnvelope {
	s.mu.Lock()
	path := agentPath
	if path == nil {
		path = []string{}
	} else {
		path = slices.Clone(path)
	}
	env := RecordEnvelope{
		Seq:        s.nextSeq,
		Kind:       kind,
		SessionID:  s.sessionID,
		SpanID:     spanID,
		AgentPath:  path,
		ReceivedAt: s.now(),
		FrameType:  frameType,
		Raw:        slices.Clone(raw),
		Events:     events,
		Control:    ctrl,
		Marker:     marker,
	}
	s.nextSeq++
	stored := env.Clone()
	s.records = append(s.records, stored)
	for _, sub := range s.subs {
		sub.enqueue(stored.Clone())
	}
	s.mu.Unlock()
	return env
}

func (s *recordStream) recordsSnapshot() []RecordEnvelope {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]RecordEnvelope, len(s.records))
	for i, r := range s.records {
		out[i] = r.Clone()
	}
	return out
}

func (s *recordStream) subscribe(afterSeq int64, fn func(RecordEnvelope)) func() {
	if fn == nil {
		return func() {}
	}
	sub := &subscriber{
		stream:   s,
		fn:       fn,
		replayed: make(chan struct{}),
	}
	sub.cond = sync.NewCond(&sub.mu)

	s.mu.Lock()
	s.nextSubID++
	sub.id = s.nextSubID
	for _, r := range s.records {
		if r.Seq > afterSeq {
			sub.pending = append(sub.pending, r.Clone())
		}
	}
	replayCount := len(sub.pending)
	s.subs[sub.id] = sub
	s.pumpWG.Add(1)
	s.mu.Unlock()

	go sub.pump(replayCount)
	<-sub.replayed

	return func() {
		sub.stop()
	}
}

func (s *recordStream) closeSubscribers() {
	s.mu.Lock()
	subs := make([]*subscriber, 0, len(s.subs))
	for _, sub := range s.subs {
		subs = append(subs, sub)
	}
	s.mu.Unlock()
	for _, sub := range subs {
		sub.stop()
	}
	s.pumpWG.Wait()
}

func (sub *subscriber) enqueue(env RecordEnvelope) {
	sub.mu.Lock()
	if !sub.stopped {
		sub.pending = append(sub.pending, env)
		sub.cond.Signal()
	}
	sub.mu.Unlock()
}

func (sub *subscriber) stop() {
	sub.stopOnce.Do(func() {
		sub.stream.mu.Lock()
		delete(sub.stream.subs, sub.id)
		sub.stream.mu.Unlock()

		sub.mu.Lock()
		sub.stopped = true
		sub.cond.Broadcast()
		sub.mu.Unlock()
	})
}

func (sub *subscriber) pump(initialReplayCount int) {
	defer sub.stream.pumpWG.Done()
	replayed := false
	signalReplay := func() {
		if !replayed {
			replayed = true
			close(sub.replayed)
		}
	}
	if initialReplayCount == 0 {
		signalReplay()
	}

	remainingReplay := initialReplayCount
	for {
		sub.mu.Lock()
		for len(sub.pending) == 0 && !sub.stopped {
			signalReplay()
			sub.cond.Wait()
		}
		if sub.stopped {
			sub.pending = nil
			sub.mu.Unlock()
			signalReplay()
			return
		}
		batch := sub.pending
		sub.pending = nil
		sub.mu.Unlock()

		for _, rec := range batch {
			sub.mu.Lock()
			stopped := sub.stopped
			sub.mu.Unlock()
			if stopped {
				signalReplay()
				return
			}
			sub.fn(rec)
			if remainingReplay > 0 {
				remainingReplay--
				if remainingReplay == 0 {
					signalReplay()
				}
			}
		}
	}
}

func readNDJSONLines(r io.Reader, handle func(raw []byte) error) error {
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		trimmed := bytes.TrimRight(line, "\r\n")
		if len(bytes.TrimSpace(trimmed)) > 0 {
			if herr := handle(trimmed); herr != nil {
				return herr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func writeJSONLine(mu *sync.Mutex, w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	mu.Lock()
	defer mu.Unlock()
	_, err = w.Write(data)
	return err
}

func classifyFailure(reason string, status *int) FailureClass {
	if status != nil {
		switch *status {
		case 401, 403:
			return FailureAuth
		case 402:
			return FailureBilling
		case 429:
			return FailureRateLimit
		case 503, 529:
			return FailureOverloaded
		}
	}
	lower := strings.ToLower(reason)
	switch {
	case strings.Contains(lower, "unauthorized") || strings.Contains(lower, "invalid api key") || strings.Contains(lower, "reauth") || strings.Contains(lower, "authentication"):
		return FailureAuth
	case strings.Contains(lower, "insufficient balance") || strings.Contains(lower, "billing") || strings.Contains(lower, "payment"):
		return FailureBilling
	case strings.Contains(lower, "quota") || strings.Contains(lower, "usage limit"):
		return FailureQuota
	case strings.Contains(lower, "rate limit") || strings.Contains(lower, "429"):
		return FailureRateLimit
	case strings.Contains(lower, "overloaded") || strings.Contains(lower, "capacity"):
		return FailureOverloaded
	case strings.Contains(lower, "context length") || strings.Contains(lower, "too many tokens") || strings.Contains(lower, "maximum context"):
		return FailureContextLength
	case strings.Contains(lower, "model not found") || strings.Contains(lower, "model_unavailable"):
		return FailureModelUnavailable
	case strings.Contains(lower, "timeout") || strings.Contains(lower, "timed out"):
		return FailureTimeout
	case strings.Contains(lower, "cancel") || strings.Contains(lower, "abort") || strings.Contains(lower, "interrupt"):
		return FailureCancelled
	case strings.Contains(lower, "network") || strings.Contains(lower, "connection"):
		return FailureNetwork
	default:
		return FailureUnknown
	}
}

func controlOutcomeRecord(stream *recordStream, action ControlAction, inputID, taskID string, outcome ControlOutcome) {
	stream.emit(RecordControl, outcome.SpanID, []string{}, string(action), nil, nil, &ControlTrace{
		Action:  action,
		InputID: inputID,
		TaskID:  taskID,
		Outcome: outcome,
	}, nil)
}

func controlNotRunning(action ControlAction, reason string) ControlOutcome {
	if reason == "" {
		reason = "session is not running"
	}
	return ControlOutcome{
		Action: action,
		Status: ControlNotRunning,
		Code:   "not_running",
		Reason: reason,
	}
}

func dispatchControl(ctx context.Context, s Session, action ControlAction, arg string, opts ...InputOption) (ControlOutcome, error) {
	switch action {
	case ControlPrompt:
		return s.Prompt(ctx, arg, opts...)
	case ControlSteer:
		return s.Steer(ctx, arg, opts...)
	case ControlQueue:
		return s.Queue(ctx, arg, opts...)
	case ControlWithdraw:
		return s.Withdraw(ctx, arg)
	case ControlAbort:
		return s.Abort(ctx)
	case ControlCompact:
		return s.Compact(ctx)
	case ControlStopTask:
		return s.StopTask(ctx, arg)
	default:
		return ControlOutcome{
			Action: action,
			Status: ControlUnsupported,
			Code:   "unsupported",
			Reason: fmt.Sprintf("unknown control action %q", action),
		}, nil
	}
}

func withdrawInput(ctx context.Context, stream *recordStream, q *inputQueue, stopped bool, inputID string) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	if stopped {
		out := controlNotRunning(ControlWithdraw, "session exited")
		controlOutcomeRecord(stream, ControlWithdraw, inputID, "", out)
		return out, nil
	}
	if !q.withdraw(inputID) {
		out := ControlOutcome{
			Action:  ControlWithdraw,
			Status:  ControlRejected,
			Code:    "not_found",
			Reason:  fmt.Sprintf("inputId %q is not queued", inputID),
			InputID: inputID,
		}
		controlOutcomeRecord(stream, ControlWithdraw, inputID, "", out)
		return out, nil
	}
	out := ControlOutcome{
		Action:  ControlWithdraw,
		Status:  ControlAccepted,
		InputID: inputID,
	}
	controlOutcomeRecord(stream, ControlWithdraw, inputID, "", out)
	return out, nil
}

func drainQueued(q *inputQueue, canDrain func() bool, promptFn func(context.Context, string, ...InputOption) (ControlOutcome, error), wg *sync.WaitGroup) {
	if !canDrain() {
		return
	}
	next, ok := q.pop()
	if !ok {
		return
	}
	var opts []InputOption
	if next.inputID != "" {
		opts = append(opts, WithInputID(next.inputID))
	}
	if next.spanID != "" {
		opts = append(opts, WithSpanID(next.spanID))
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = promptFn(context.Background(), next.input, opts...)
	}()
}
