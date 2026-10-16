package codex

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// rpcControlPlan is a control action backed by one app-server RPC (rpc-control.ts).
type rpcControlPlan struct {
	body oar.RequestBody
	// Runtime-specific refusal before sending (busy, nothing active); nil
	// means proceed. May reserve adapter state. Reachability is not its job.
	gate   func(request oar.RawEvent) *oar.ResponseBody
	method string
	params func() any
	// onReply and onError decide the response; they run with s.mu held.
	onReply func(reply rpcResult) oar.ResponseBody
	onError func(message string) oar.ResponseBody
	// onPending arms a turn fallback that can take over and accept before the RPC settles.
	onPending func(accept func())
}

func rejected(code oar.RejectionCode, reason string) *oar.ResponseBody {
	body := oar.Rejected(code, reason)
	return &body
}

// rpcControl records the request; when the stream already says the runtime
// is unreachable (kernel.Unreachable: exited or disposed), or input is empty
// with no images, it records that rejection without running the plan; if
// the plan's gate refuses, it records that; otherwise it sends and records
// the reply AS the reply line is read (through the client's onSettled), so
// the response sits in the stream before any notification codex wrote after
// it. build runs with s.mu held, as the TS plan builders read adapter state
// in the calling tick.
func (s *codexSession) rpcControl(ctx context.Context, build func() rpcControlPlan) (oar.ControlResult, error) {
	s.mu.Lock()
	plan := build()
	blocked := s.k.Unreachable()
	request := s.k.Request(oar.ToRuntime, plan.body, kernel.RecordAt{})
	refused := blocked
	if refused == nil {
		refused = kernel.EmptyInputRefusal(plan.body)
	}
	if refused == nil {
		refused = plan.gate(request)
	}
	if refused != nil {
		response := s.k.Respond(request.ID, *refused, kernel.RecordAt{})
		s.mu.Unlock()
		return oar.ControlResult{Request: request, Response: response}, nil
	}
	from := s.k.Len()
	recorded := false
	record := func(decided oar.ResponseBody) {
		if !recorded {
			recorded = true
			s.k.Respond(request.ID, decided, kernel.RecordAt{})
		}
	}
	if plan.onPending != nil {
		plan.onPending(func() { record(oar.Accepted()) })
	}
	params := plan.params()
	s.mu.Unlock()
	// A fallback answers independently of transport settlement. Keep
	// observing the RPC: a late native reply remains a frame, never a second response.
	go func() {
		_, err := s.client.request(context.Background(), plan.method, params, func(outcome rpcOutcome) {
			s.mu.Lock()
			defer s.mu.Unlock()
			switch {
			case recorded:
				if outcome.kind == "result" {
					s.k.Frame(oar.FrameBody{Type: plan.method, Native: outcome.result.raw}, kernel.RecordAt{})
				} else if outcome.kind == "error" && outcome.native != nil {
					s.k.Frame(oar.FrameBody{Type: plan.method, Native: jsonx.Marshal(outcome.native)}, kernel.RecordAt{})
				}
			case outcome.kind == "exited":
				record(*rejected(oar.CodeRuntimeExited, outcome.err.Error()))
			case outcome.kind == "result":
				record(plan.onReply(outcome.result))
			default:
				record(plan.onError(outcome.err.Error()))
			}
		})
		if err != nil {
			s.mu.Lock()
			if !recorded {
				record(plan.onError(err.Error()))
			}
			s.mu.Unlock()
		}
	}()
	response, err := s.k.WaitFor(ctx, from, func(candidate oar.RawEvent) bool {
		return candidate.Kind == oar.KindResponse && candidate.RequestID == request.ID
	})
	if err != nil {
		return oar.ControlResult{}, err
	}
	return oar.ControlResult{Request: request, Response: response}, nil
}

var archivedSession = regexp.MustCompile(`^session \S+ is archived\.`)
var activeWriter = regexp.MustCompile(`^thread \S+ already has an active writer$`)

// unavailableReason is a resume target codex keeps but will not open now,
// by its words on the `-32600` it shares with a missing rollout ([env] codex
// 0.162.0, experiments/codex-session-name.ts): the user archived it in their
// app, or another app-server (their app) is its writer.
func unavailableReason(message string) string {
	if archivedSession.MatchString(message) {
		return "archived"
	}
	if activeWriter.MatchString(message) {
		return "in_use"
	}
	return ""
}

// resumeError is the typed error for a resume codex refused, or nil. Codex
// 0.162.0 uses -32600 for a missing rollout, an archived thread, an active
// writer and unloaded sub-agents alike, so its words are the last resort:
// the missing rollout's are pinned by missing-resume-errors.json, the other
// two by the codex-session-name vendor test. The session id is redacted
// here: the credential redactor keeps typed errors' ids as they are.
func resumeError(method, resumeID string, err error, message string, redact func(string) string) error {
	var failure *rpcError
	if method != methodThreadResume || resumeID == "" || !errors.As(err, &failure) || failure.cause.Method != method {
		return nil
	}
	native := failure.cause.Native
	code, _ := native["code"].(float64)
	nativeMessage, isString := native["message"].(string)
	if code != -32600 || !isString {
		return nil
	}
	text := "codex " + method + " failed: " + message
	if strings.HasPrefix(nativeMessage, "no rollout found for thread id") {
		return &oar.SessionNotFoundError{SessionID: redact(resumeID), Message: text, Method: method, Native: jsonx.Marshal(native)}
	}
	reason := unavailableReason(nativeMessage)
	if reason == "" {
		return nil
	}
	return &oar.SessionUnavailableError{SessionID: redact(resumeID), Message: text, Reason: reason, Method: method, Native: jsonx.Marshal(native)}
}

// openThread runs an open RPC, with its failure named after the method (a
// refused resume must say `thread/resume`: "no rollout found for thread id
// …" alone does not) and the app-server that was started for it killed.
func openThread(client appServerClient, method string, send func() (rpcResult, error), serviceTier, resumeID string, redact func(string) string) (rpcResult, error) {
	result, err := send()
	if err == nil {
		return result, nil
	}
	client.kill()
	message := err.Error()
	if typed := resumeError(method, resumeID, err, message, redact); typed != nil {
		return rpcResult{}, typed
	}
	detail := message
	if serviceTier != "" {
		detail = "serviceTier " + serviceTier + " could not be confirmed (actual unreported): " + message
	}
	wrapped := &rpcError{message: "codex " + method + " failed: " + detail}
	var failure *rpcError
	if errors.As(err, &failure) {
		wrapped.cause = failure.cause
	}
	return rpcResult{}, wrapped
}

// nameThread sets SessionOptions.Name (#368) on the opened thread, when
// there is one to set (codexThreadName); a name codex refuses fails the open.
func nameThread(ctx context.Context, client appServerClient, threadID string, name *string) error {
	if name == nil {
		return nil
	}
	_, err := openThread(client, "thread/name/set", func() (rpcResult, error) {
		return client.request(ctx, "thread/name/set", jsonx.Record{"threadId": threadID, "name": *name}, nil)
	}, "", "", nil)
	return err
}
