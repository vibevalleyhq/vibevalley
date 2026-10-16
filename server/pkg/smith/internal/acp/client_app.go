package acp

import (
	"encoding/json"

	"vibevalley/pkg/smith/internal/jsonx"
)

// ClientHooks is what the session records about the runtime→app traffic
// routed to this client (client-app.ts AcpClientHooks): every request
// (permission, terminal) with its id and params, oar's answer to it, every
// `session/update`, and every vendor extension notification the profile
// subscribed to. The terminal host stays pure. Update, Extension and
// Requested run on the reader in wire order; Answered on the request's own
// goroutine, before the answer is written.
type ClientHooks struct {
	Update func(params json.RawMessage)
	// A runtime→app request arrived.
	Requested func(id, method string, params json.RawMessage)
	// oar answered (or failed) a runtime→app request.
	Answered               func(id string, reply any)
	Extension              func(method string, params json.RawMessage, afterOpen bool)
	ExtensionNotifications []string
}

// AllowPermission is OAR's YOLO answer to a permission request: the
// broadest allow on offer, else cancel.
func AllowPermission(request jsonx.Record) jsonx.Record {
	options := jsonx.AsRecordList(request["options"])
	var selected jsonx.Record
	for _, kind := range []string{"allow_always", "allow_once"} {
		for _, option := range options {
			if option["kind"] == kind {
				selected = option
				break
			}
		}
		if selected != nil {
			break
		}
	}
	if selected == nil {
		return jsonx.Record{"outcome": jsonx.Record{"outcome": "cancelled"}}
	}
	return jsonx.Record{"outcome": jsonx.Record{"outcome": "selected", "optionId": selected["optionId"]}}
}

// NewClientApp composes OAR's ACP client handlers (createAcpClientApp).
func NewClientApp(terminal *TerminalHost, hooks ClientHooks) *ClientApp {
	// Every client request is a toApp request record; the reply (or the
	// error) is the answered response.
	observed := func(method string, handle func(params json.RawMessage) (any, error)) RequestHandler {
		return func(id string, params json.RawMessage) func() (any, error) {
			hooks.Requested(id, method, params)
			return func() (any, error) {
				reply, err := handle(params)
				if err != nil {
					hooks.Answered(id, jsonx.Record{"error": err.Error()})
					return nil, err
				}
				hooks.Answered(id, reply)
				return reply, nil
			}
		}
	}
	app := NewClient().
		OnRequest(MethodRequestPermission, observed(MethodRequestPermission, func(params json.RawMessage) (any, error) {
			return AllowPermission(jsonx.ParseRecord(params)), nil
		})).
		OnRequest(MethodTerminalCreate, observed(MethodTerminalCreate, func(params json.RawMessage) (any, error) {
			return decodeThen(params, terminal.Create)
		})).
		OnRequest(MethodTerminalOutput, observed(MethodTerminalOutput, func(params json.RawMessage) (any, error) {
			return decodeThen(params, terminal.Output)
		})).
		OnRequest(MethodTerminalWaitForExit, observed(MethodTerminalWaitForExit, func(params json.RawMessage) (any, error) {
			return decodeThen(params, terminal.WaitForExit)
		})).
		OnRequest(MethodTerminalKill, observed(MethodTerminalKill, func(params json.RawMessage) (any, error) {
			return decodeThen(params, terminal.Kill)
		})).
		OnRequest(MethodTerminalRelease, observed(MethodTerminalRelease, func(params json.RawMessage) (any, error) {
			return decodeThen(params, terminal.Release)
		})).
		OnNotification(MethodSessionUpdate, func(params json.RawMessage, _ bool) {
			hooks.Update(params)
		})
	for _, method := range hooks.ExtensionNotifications {
		app.OnNotification(method, func(params json.RawMessage, afterOpen bool) {
			// A non-object params reads as {} (passthrough in client-app.ts).
			if jsonx.ParseRecord(params) == nil {
				params = json.RawMessage("{}")
			}
			hooks.Extension(method, params, afterOpen)
		})
	}
	return app
}

// decodeThen decodes typed params, refusing ones that do not fit the schema
// (the SDK's zod validation answers invalid params).
func decodeThen[Params any, Reply any](raw json.RawMessage, handle func(Params) (Reply, error)) (any, error) {
	var params Params
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, NewRequestError(-32602, "Invalid params", map[string]any{"details": err.Error()})
	}
	reply, err := handle(params)
	if err != nil {
		return nil, err
	}
	return reply, nil
}
