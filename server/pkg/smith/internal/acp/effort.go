package acp

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// causedError is an Error with a cause (TS `new Error(message, {cause})`).
type causedError struct {
	message string
	cause   error
}

func (e *causedError) Error() string { return e.message }
func (e *causedError) Unwrap() error { return e.cause }

// rpcErrorText is an RPC error's message plus its `data` (grok puts the
// reason there: "unknown reasoning_effort value").
func rpcErrorText(err error) string {
	var failure *RequestError
	if !errors.As(err, &failure) || !failure.HasData || failure.Data == nil {
		return err.Error()
	}
	if text, ok := failure.Data.(string); ok {
		return failure.Message + " (" + text + ")"
	}
	return failure.Message + " (" + jsonx.Stringify(failure.DataRaw) + ")"
}

// OpenStep is one native call while opening, as the handshake observer sees it.
type OpenStep struct {
	Method   string
	Response json.RawMessage
}

// OpenObserver receives the native handshake answers in wire order.
type OpenObserver func(step OpenStep)

// OpenedHandshake is what ApplyEffort reads the effort menu from.
type OpenedHandshake struct {
	Response   jsonx.Record
	SessionID  string
	OpenMethod string
}

// ApplyEffort applies SessionOptions.Effort through the agent's
// `thought_level` config option (effort.ts applyAcpEffort):
// `session/set_config_option {configId, value}`, whose answer lists every
// option with its current value. The answer is observed like any handshake
// answer, and anything but the requested level as the option's
// `currentValue` refuses the open: an agent without the option, one that
// refuses the value (grok 1.0.41 and kimi 2.0.0 answer `-32602`), or one
// that applies another. Applied after `session/set_model`, because a model
// switch re-derives the option's menu for the new model.
func ApplyEffort(ctx context.Context, process *Process, opened OpenedHandshake, effort string, timeout time.Duration, observe OpenObserver) error {
	configID, _ := ThoughtLevelOption(opened.Response)["id"].(string)
	if configID == "" {
		// No effort channel at all: the option, not the level, is what this runtime cannot honor.
		return &oar.UnsupportedOptionError{Option: "effort", Message: opened.OpenMethod + " advertises no thought_level config option, so effort " + effort + " cannot be applied"}
	}
	method := MethodSessionSetConfig
	answer, err := process.Request(ctx, method, map[string]any{"sessionId": opened.SessionID, "configId": configID, "value": effort}, timeout)
	if err != nil {
		return &causedError{message: method + " " + configID + "=" + effort + " was refused: " + rpcErrorText(err), cause: err}
	}
	response := objectOrEmpty(answer)
	observe(OpenStep{Method: method, Response: response})
	applied, ok := ReportedEffort(jsonx.ParseRecord(response))
	if !ok || applied != effort {
		reported := "an unreported value"
		if ok {
			reported = applied
		}
		return errors.New(method + " left " + configID + " at " + reported + " although effort " + effort + " was requested")
	}
	return nil
}

// objectOrEmpty is the answer when it is a JSON object, else `{}` (asRecord(answer) ?? {}).
func objectOrEmpty(answer json.RawMessage) json.RawMessage {
	if jsonx.ParseRecord(answer) == nil {
		return json.RawMessage("{}")
	}
	return answer
}

// ApplyModel applies SessionOptions.Model: `session/set_model {modelId}`,
// or with viaConfigOption `session/set_config_option` on the `model` option
// (for agents whose set_model answer reports nothing, agy_acp_server 1.2.1).
// The answer is observed like any handshake answer and returned (nil when
// it was not an object).
func ApplyModel(ctx context.Context, process *Process, sessionID, model string, viaConfigOption bool, timeout time.Duration, observe OpenObserver) (jsonx.Record, error) {
	method := MethodSessionSetModel
	var params any = map[string]any{"sessionId": sessionID, "modelId": model}
	if viaConfigOption {
		method = MethodSessionSetConfig
		params = map[string]any{"sessionId": sessionID, "configId": "model", "value": model}
	}
	answer, err := process.Request(ctx, method, params, timeout)
	if err != nil {
		return nil, err
	}
	observe(OpenStep{Method: method, Response: objectOrEmpty(answer)})
	return jsonx.ParseRecord(answer), nil
}
