package claude

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Bounded native readbacks at open, consumed before the ordinary
// projection stream (open-settings.ts). Successful readbacks contain
// private configuration or account details (get_settings: user config and
// credentials; initialize and get_usage: account details), so their answers
// never enter records.

func failedInitialization(message jsonx.Record) bool {
	return message["type"] == "result" && message["subtype"] == "error_during_execution"
}

// settingsAnswer is a readback's answer: the control_response (or a failed
// initialization result), or the error that stands for it (timeout, exit).
type settingsAnswer struct {
	record jsonx.Record
	err    error
}

func refusalFor(answer settingsAnswer, option, requested string, options oar.SessionOptions) string {
	if answer.err != nil {
		return answer.err.Error() + ", so " + option + " " + requested + " cannot be confirmed"
	}
	if failedInitialization(answer.record) {
		var lines []string
		for _, entry := range jsonx.AsList(answer.record["errors"]) {
			if text, ok := entry.(string); ok {
				lines = append(lines, text)
			}
		}
		if joined := strings.Join(lines, "\n"); joined != "" {
			return joined
		}
		return "claude initialization failed (result/error_during_execution)"
	}
	switch option {
	case "effort":
		return claudeEffortRefusal(requested, answer.record)
	case "serviceTier":
		return claudeServiceTierRefusal(requested, answer.record)
	}
	response := jsonx.AsRecord(answer.record["response"])
	if response["subtype"] != "success" {
		reason, ok := response["error"].(string)
		if !ok {
			reason = "no success answer"
		}
		return "claude could not resume " + requested + " (initialize: " + reason + ")"
	}
	if options.ServiceTier == "" {
		return ""
	}
	return claudeServiceTierRefusal(options.ServiceTier, answer.record)
}

// failureNative: successful readbacks contain private configuration or
// account details, never error diagnostics; nil for those.
func failureNative(answer settingsAnswer) jsonx.Record {
	if answer.err != nil {
		return nil
	}
	if failedInitialization(answer.record) {
		return answer.record
	}
	response := jsonx.AsRecord(answer.record["response"])
	if response["subtype"] == "error" {
		return response
	}
	return nil
}

// readbackError is an open a readback refused, with its redacted native
// cause (TS: Error with cause {method, native}).
type readbackError struct {
	message string
	Method  string
	Native  jsonx.Record
}

func (e *readbackError) Error() string { return e.message }

type settingsPending struct {
	id     string
	method string
	answer chan settingsAnswer
}

// openSettings holds the readbacks of one claude process. consume and
// exited run with the session lock held; confirm and usageBaseline take it
// themselves and release it while they wait.
type openSettings struct {
	lock  sync.Locker
	child claudeProcess

	pending    *settingsPending
	privateIDs map[string]bool
	exitedNow  bool
	code       *int
	failure    jsonx.Record
	opening    bool
}

func newOpenSettings(child claudeProcess, lock sync.Locker) *openSettings {
	return &openSettings{lock: lock, child: child, privateIDs: map[string]bool{}, opening: true}
}

func settleSettings(pending *settingsPending, answer settingsAnswer) {
	select {
	case pending.answer <- answer:
	default:
	}
}

func (o *openSettings) exitError(method string) error {
	code := "null"
	if o.code != nil {
		code = fmt.Sprint(*o.code)
	}
	return fmt.Errorf("claude exited (code %s) before answering %s", code, method)
}

// consume is true for private readbacks, whose account details and configuration must not enter records.
func (o *openSettings) consume(message jsonx.Record) bool {
	if o.opening && failedInitialization(message) {
		o.failure = message
		if o.pending != nil {
			settleSettings(o.pending, settingsAnswer{record: message})
		}
	}
	id := claudeControlResponseID(message)
	if o.pending != nil && id != "" && id == o.pending.id {
		settleSettings(o.pending, settingsAnswer{record: message})
	}
	return id != "" && o.privateIDs[id]
}

func (o *openSettings) exited(code *int) {
	o.exitedNow = true
	o.code = code
	if o.pending != nil {
		settleSettings(o.pending, settingsAnswer{err: o.exitError(o.pending.method)})
	}
}

// ask writes one readback and waits for its answer, the lock released while waiting.
func (o *openSettings) ask(method, id string, write func()) settingsAnswer {
	pending := &settingsPending{id: id, method: method, answer: make(chan settingsAnswer, 1)}
	o.lock.Lock()
	o.pending = pending
	o.privateIDs[id] = true
	switch {
	case o.failure != nil:
		settleSettings(pending, settingsAnswer{record: o.failure})
	case o.exitedNow:
		settleSettings(pending, settingsAnswer{err: o.exitError(method)})
	default:
		write()
	}
	o.lock.Unlock()
	timer := time.NewTimer(claudeEffortReadback)
	defer timer.Stop()
	var answer settingsAnswer
	select {
	case answer = <-pending.answer:
	case <-timer.C:
		answer = settingsAnswer{err: fmt.Errorf("claude did not answer %s within %d ms", method, claudeEffortReadback.Milliseconds())}
	}
	o.lock.Lock()
	if o.pending == pending {
		o.pending = nil
	}
	o.lock.Unlock()
	return answer
}

func (o *openSettings) confirmOne(method, option, requested string, options oar.SessionOptions, redact func(string) string) error {
	id := "oar-" + option + "-" + observe.NewUUID()
	answer := o.ask(method, id, func() {
		if method == "get_settings" {
			o.child.Write(claudeSettingsRequest(id))
		} else {
			o.child.Write(jsonText(controlRequest{Type: "control_request", RequestID: id, Request: map[string]any{"subtype": method}}) + "\n")
		}
	})
	refusal := refusalFor(answer, option, requested, options)
	if refusal == "" {
		return nil
	}
	native := failureNative(answer)
	// Only a missing-resume result that won the initialize readback.
	// Prose is the last resort, pinned by claude-missing-resume.json.
	if option == "resume" && method == "initialize" && native != nil && failedInitialization(native) {
		if errs := jsonx.AsList(native["errors"]); len(errs) > 0 {
			if first, ok := errs[0].(string); ok && strings.HasPrefix(first, "No conversation found with session ID") {
				cause := shared.NativeErrorCause(method, native, redact)
				// The id is redacted too: TS redacts the whole error, the Go redactor only its message and native.
				return &oar.SessionNotFoundError{SessionID: redact(requested), Message: redact(refusal), Method: method, Native: jsonx.Marshal(cause.Native)}
			}
		}
	}
	if native == nil {
		return errors.New(redact(refusal))
	}
	cause := shared.NativeErrorCause(method, native, redact)
	return &readbackError{message: redact(refusal), Method: cause.Method, Native: cause.Native}
}

// confirm checks what the session was opened with against what claude
// applied. On any failure claude is stopped (and waited for) before the
// error returns.
func (o *openSettings) confirm(options oar.SessionOptions, redact func(string) string) error {
	defer func() {
		o.lock.Lock()
		o.opening = false
		o.failure = nil
		o.lock.Unlock()
	}()
	check := func(method, option, requested string) error {
		if requested == "" {
			return nil
		}
		if err := o.confirmOne(method, option, requested, options, redact); err != nil {
			o.child.Kill()
			<-o.child.Exited()
			return err
		}
		return nil
	}
	// Missing resumes report a result error and exit without an initialize
	// answer. Confirm that handshake before any settings readback.
	if options.Resume != "" {
		if err := check("initialize", "resume", options.Resume); err != nil {
			return err
		}
	}
	if err := check("get_settings", "effort", options.Effort); err != nil {
		return err
	}
	if options.Resume == "" {
		if err := check("initialize", "serviceTier", options.ServiceTier); err != nil {
			return err
		}
	}
	return nil
}

// usageBaseline is a resume's token baseline: claude's get_usage
// session.model_usage, the running total the resumed process continues.
// Never fails or stops the process: a timeout, an exit, an error answer or
// one without session totals is an unknown baseline. The answer also
// carries account data, so it stays private like the others.
func (o *openSettings) usageBaseline() usageBaseline {
	o.lock.Lock()
	gone := o.exitedNow
	o.lock.Unlock()
	if gone {
		return usageBaseline{Kind: "unknown"}
	}
	id := "oar-usage-" + observe.NewUUID()
	pending := &settingsPending{id: id, method: "get_usage", answer: make(chan settingsAnswer, 1)}
	o.lock.Lock()
	o.pending = pending
	o.privateIDs[id] = true
	// skip_behaviors: the answer's local-transcript scan is not needed.
	o.child.Write(jsonText(controlRequest{Type: "control_request", RequestID: id, Request: map[string]any{"subtype": "get_usage", "skip_behaviors": true}}) + "\n")
	o.lock.Unlock()
	timer := time.NewTimer(claudeEffortReadback)
	defer timer.Stop()
	var answer settingsAnswer
	select {
	case answer = <-pending.answer:
	case <-timer.C:
		answer = settingsAnswer{err: errors.New("claude did not answer get_usage")}
	}
	o.lock.Lock()
	if o.pending == pending {
		o.pending = nil
	}
	o.lock.Unlock()
	if answer.err != nil {
		return usageBaseline{Kind: "unknown"}
	}
	return claudeUsageBaseline(answer.record)
}
