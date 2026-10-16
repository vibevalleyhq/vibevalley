package kernel

import (
	"context"
	"errors"
	"regexp"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ErrInputIDNotUUID is returned for an inputId that is not a UUID.
var ErrInputIDNotUUID = errors.New("inputId must be a UUID")

func identify(options oar.InputOptions) (oar.InputOptions, error) {
	if options.InputID == "" {
		options.InputID = observe.NewUUID()
	}
	if !uuidPattern.MatchString(options.InputID) {
		return options, ErrInputIDNotUUID
	}
	return options, nil
}

// ControlOutcomeOf reads a control's answer off its two records.
func ControlOutcomeOf(result oar.ControlResult) oar.ControlOutcome {
	outcome := oar.ControlOutcome{ControlResult: result, Seq: result.Request.Seq, RequestID: result.Request.ID}
	switch result.Response.Response.Kind {
	case oar.ResponseRejected:
		outcome.Kind = oar.ResponseRejected
		outcome.Code = result.Response.Response.Code
		outcome.Reason = result.Response.Response.Reason
	case oar.ResponseExited:
		outcome.Kind = oar.ResponseRejected
		outcome.Code = oar.CodeRuntimeExited
		outcome.Reason = "runtime exited"
	default:
		outcome.Kind = oar.ResponseAccepted
	}
	return outcome
}

// sealed is the API face over an adapter (shared/seal-session.ts): read
// control answers, the flat events reading, the stream folds, and the
// steer-or-queue and deliver policies.
type sealed struct {
	adapter oar.AdapterSession
	redact  func(error) error
}

// Seal derives the API face of a Session from what the adapter built.
func Seal(adapter oar.AdapterSession) oar.Session {
	return &sealed{adapter: adapter}
}

// SealRedacting is Seal with adapter errors passed through redact.
func SealRedacting(adapter oar.AdapterSession, redact func(error) error) oar.Session {
	return &sealed{adapter: adapter, redact: redact}
}

func (s *sealed) guard(err error) error {
	if err == nil || s.redact == nil {
		return err
	}
	return s.redact(err)
}

func (s *sealed) outcome(result oar.ControlResult, err error) (oar.ControlOutcome, error) {
	if err != nil {
		return oar.ControlOutcome{}, s.guard(err)
	}
	return ControlOutcomeOf(result), nil
}

func (s *sealed) ID() string                            { return s.adapter.ID() }
func (s *sealed) Capabilities() oar.SessionCapabilities { return s.adapter.Capabilities() }

func (s *sealed) Prompt(ctx context.Context, input string, options oar.InputOptions) (oar.ControlOutcome, error) {
	identified, err := identify(options)
	if err != nil {
		return oar.ControlOutcome{}, err
	}
	return s.outcome(s.adapter.Prompt(ctx, input, identified))
}

func (s *sealed) CanSteer() bool {
	_, ok := s.adapter.(oar.Steerer)
	return ok
}

func (s *sealed) Steer(ctx context.Context, input string, options oar.InputOptions) (oar.ControlOutcome, error) {
	steerer, ok := s.adapter.(oar.Steerer)
	if !ok {
		return oar.ControlOutcome{}, oar.ErrControlUnsupported
	}
	identified, err := identify(options)
	if err != nil {
		return oar.ControlOutcome{}, err
	}
	return s.outcome(steerer.Steer(ctx, input, identified))
}

func (s *sealed) Queue(ctx context.Context, input string, options oar.InputOptions) (oar.ControlOutcome, error) {
	identified, err := identify(options)
	if err != nil {
		return oar.ControlOutcome{}, err
	}
	return s.outcome(s.adapter.Queue(ctx, input, identified))
}

func (s *sealed) CanWithdraw() bool {
	_, ok := s.adapter.(oar.Withdrawer)
	return ok
}

func (s *sealed) Withdraw(ctx context.Context, inputID string) (oar.ControlOutcome, error) {
	withdrawer, ok := s.adapter.(oar.Withdrawer)
	if !ok {
		return oar.ControlOutcome{}, oar.ErrControlUnsupported
	}
	return s.outcome(withdrawer.Withdraw(ctx, inputID))
}

func (s *sealed) Abort(ctx context.Context) (oar.ControlOutcome, error) {
	return s.outcome(s.adapter.Abort(ctx))
}

func (s *sealed) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.adapter.RawEvents(observer, cursor)
}

func (s *sealed) Events(observer oar.EventObserver, options oar.EventsOptions) oar.Unsubscribe {
	target := observer
	if options.CoalesceText {
		target = observe.CoalesceText(observer, time.Duration(options.MaxHoldMs)*time.Millisecond)
	}
	return s.adapter.RawEvents(observe.EventsReader(target), options.Cursor)
}

func (s *sealed) Records() []oar.RawEvent { return s.adapter.Records() }
func (s *sealed) Graph() oar.SessionGraph { return s.adapter.Graph() }

func (s *sealed) Model() oar.QueryResult[*string] {
	return observe.ModelOf(s.adapter.Records(), s.adapter.ID())
}

func (s *sealed) Effort() oar.QueryResult[*string] {
	return observe.EffortOf(s.adapter.Records(), s.adapter.ID())
}

func (s *sealed) ServiceTier() oar.QueryResult[*string] {
	return observe.ServiceTierOf(s.adapter.Records(), s.adapter.ID())
}

func (s *sealed) Usage() oar.QueryResult[oar.SessionUsage] {
	graph := s.adapter.Graph()
	return observe.UsageOf(s.adapter.Records(), s.adapter.ID(), &graph)
}

func (s *sealed) ContextUsage() oar.QueryResult[*oar.ContextUsage] {
	return observe.ContextUsageOf(s.adapter.Records(), s.adapter.ID())
}

func (s *sealed) Status() oar.QueryResult[oar.AgentStatus] {
	return observe.StatusOf(s.adapter.Records(), s.adapter.ID())
}

func (s *sealed) SteerOrQueue(ctx context.Context, input string, options oar.InputOptions) (oar.SteerOrQueueResult, error) {
	identified, err := identify(options)
	if err != nil {
		return oar.SteerOrQueueResult{}, err
	}
	if s.CanSteer() {
		steered, err := s.Steer(ctx, input, identified)
		if err != nil {
			return oar.SteerOrQueueResult{}, err
		}
		if steered.IsAccepted() {
			return oar.SteerOrQueueResult{Landed: "steered", Result: steered}, nil
		}
	}
	queued, err := s.Queue(ctx, input, identified)
	if err != nil {
		return oar.SteerOrQueueResult{}, err
	}
	if queued.IsAccepted() {
		return oar.SteerOrQueueResult{Landed: "queued", Result: queued}, nil
	}
	return oar.SteerOrQueueResult{Landed: "rejected", Code: queued.Code, Reason: queued.Reason, Result: queued}, nil
}

func (s *sealed) Deliver(ctx context.Context, input string, options oar.DeliverOptions) (oar.DeliverResult, error) {
	identified, err := identify(options.InputOptions)
	if err != nil {
		return oar.DeliverResult{}, err
	}
	options.InputOptions = identified
	return DeliverInto(ctx, s, input, options)
}

func (s *sealed) CanReadResources() bool {
	_, ok := s.adapter.(oar.ResourceReader)
	return ok
}

func (s *sealed) CanReadContextBreakdown() bool {
	_, ok := s.adapter.(oar.ContextBreakdownReader)
	return ok
}

func (s *sealed) Resources(ctx context.Context) (*oar.SessionResources, error) {
	reader, ok := s.adapter.(oar.ResourceReader)
	if !ok {
		return nil, oar.ErrControlUnsupported
	}
	resources, err := reader.Resources(ctx)
	return resources, s.guard(err)
}

func (s *sealed) ContextBreakdown(ctx context.Context) (*oar.ContextBreakdown, error) {
	reader, ok := s.adapter.(oar.ContextBreakdownReader)
	if !ok {
		return nil, oar.ErrControlUnsupported
	}
	breakdown, err := reader.ContextBreakdown(ctx)
	return breakdown, s.guard(err)
}

func (s *sealed) Dispose(ctx context.Context) error {
	return s.guard(s.adapter.Dispose(ctx))
}

// ─── deliver (shared/deliver.ts) ───────────────────────────────────────────

const maxDeliverAttempts = 4

func landed(kind, inputID string, result oar.ControlOutcome) oar.DeliverResult {
	return oar.DeliverResult{Landed: kind, InputID: inputID, Result: &result}
}

func refused(inputID string, result oar.ControlOutcome) oar.DeliverResult {
	if result.Kind == oar.ResponseRejected {
		return oar.DeliverResult{Landed: "rejected", InputID: inputID, Code: result.Code, Reason: result.Reason, Result: &result}
	}
	return oar.DeliverResult{Landed: "rejected", InputID: inputID, Code: oar.CodeUnsupported, Reason: "accepted", Result: &result}
}

func runningSince(session oar.Session) (int64, bool) {
	status := session.Status().Value
	if status.IsRunning() {
		return status.SinceSeq, true
	}
	return 0, false
}

// intoRunning is one attempt into a running turn; nil when the turn ended meanwhile.
func intoRunning(ctx context.Context, session oar.Session, input string, options oar.InputOptions, when oar.DeliverWhen) (*oar.DeliverResult, error) {
	if when == "now" && session.CanSteer() {
		target, targetRunning := runningSince(session)
		steered, err := session.Steer(ctx, input, options)
		if err != nil {
			return nil, err
		}
		if steered.IsAccepted() {
			result := landed("steered", options.InputID, steered)
			return &result, nil
		}
		now, nowRunning := runningSince(session)
		if steered.Code == oar.CodeNoActiveTurn || now != target || nowRunning != targetRunning {
			return nil, nil
		}
		if steered.Code != oar.CodeUnsupported {
			result := refused(options.InputID, steered)
			return &result, nil
		}
	}
	queued, err := session.Queue(ctx, input, options)
	if err != nil {
		return nil, err
	}
	var result oar.DeliverResult
	if queued.IsAccepted() {
		result = landed("queued", options.InputID, queued)
	} else {
		result = refused(options.InputID, queued)
	}
	return &result, nil
}

// DeliverInto is Session.Deliver derived from the session's own controls and status.
func DeliverInto(ctx context.Context, session oar.Session, input string, options oar.DeliverOptions) (oar.DeliverResult, error) {
	when := options.When
	if when == "" {
		when = "now"
	}
	var last *oar.ControlOutcome
	for attempt := 0; attempt < maxDeliverAttempts; attempt++ {
		if when == "when_idle" {
			if _, err := observe.AwaitIdle(ctx, session); err != nil {
				return oar.DeliverResult{}, err
			}
		}
		if session.Status().Value.Kind == "idle" {
			prompted, err := session.Prompt(ctx, input, options.InputOptions)
			if err != nil {
				return oar.DeliverResult{}, err
			}
			last = &prompted
			if prompted.IsAccepted() {
				return landed("prompted", options.InputID, prompted), nil
			}
			if prompted.Code != oar.CodeBusy {
				return refused(options.InputID, prompted), nil
			}
		}
		if when != "when_idle" {
			result, err := intoRunning(ctx, session, input, options.InputOptions, when)
			if err != nil {
				return oar.DeliverResult{}, err
			}
			if result != nil {
				return *result, nil
			}
		}
	}
	if last == nil {
		return oar.DeliverResult{Landed: "rejected", InputID: options.InputID, Code: oar.CodeBusy, Reason: "the session kept changing state; nothing was delivered"}, nil
	}
	return refused(options.InputID, *last), nil
}
