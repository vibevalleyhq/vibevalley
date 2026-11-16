package oar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("json-rpc error %d: %s", e.Code, e.Message)
}

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcResult struct {
	result json.RawMessage
	err    error
}

// rpcPeer speaks bidirectional line-delimited JSON-RPC over a Process's stdin and stdout.
type rpcPeer struct {
	writeMu sync.Mutex
	stdin   io.Writer
	nextID  atomic.Int64

	pendingMu sync.Mutex
	pending   map[string]chan rpcResult
	closed    bool

	onNotification func(method string, params json.RawMessage, raw []byte)
	onRequest      func(id json.RawMessage, method string, params json.RawMessage, raw []byte) (any, *rpcError)
	onEOF          func(err error)
}

func newRPCPeer(
	stdin io.Writer,
	onNotification func(method string, params json.RawMessage, raw []byte),
	onRequest func(id json.RawMessage, method string, params json.RawMessage, raw []byte) (any, *rpcError),
	onEOF func(err error),
) *rpcPeer {
	return &rpcPeer{
		stdin:          stdin,
		pending:        make(map[string]chan rpcResult),
		onNotification: onNotification,
		onRequest:      onRequest,
		onEOF:          onEOF,
	}
}

func (p *rpcPeer) readLoop(stdout io.Reader) {
	err := readNDJSONLines(stdout, func(raw []byte) error {
		var msg rpcEnvelope
		if jerr := json.Unmarshal(raw, &msg); jerr != nil {
			// Non-JSON diagnostic stdout lines are surfaced via notification callback with empty method if desired.
			return nil
		}
		hasID := len(msg.ID) > 0 && string(msg.ID) != "null"
		if msg.Method != "" && hasID {
			p.handleServerRequest(msg.ID, msg.Method, msg.Params, raw)
			return nil
		}
		if msg.Method != "" {
			if p.onNotification != nil {
				p.onNotification(msg.Method, msg.Params, raw)
			}
			return nil
		}
		if hasID {
			key := normalizeRPCID(msg.ID)
			p.pendingMu.Lock()
			ch := p.pending[key]
			delete(p.pending, key)
			p.pendingMu.Unlock()
			if ch != nil {
				var rerr error
				if msg.Error != nil {
					rerr = msg.Error
				}
				ch <- rpcResult{result: msg.Result, err: rerr}
			}
		}
		return nil
	})
	p.failAllPending(err)
	if p.onEOF != nil {
		p.onEOF(err)
	}
}

func (p *rpcPeer) handleServerRequest(id json.RawMessage, method string, params json.RawMessage, raw []byte) {
	var res any
	var rerr *rpcError
	if p.onRequest != nil {
		res, rerr = p.onRequest(id, method, params, raw)
	} else {
		rerr = &rpcError{Code: -32601, Message: "method not found: " + method}
	}
	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
	}
	if rerr != nil {
		resp["error"] = rerr
	} else {
		if res == nil {
			res = map[string]any{}
		}
		resp["result"] = res
	}
	_ = writeJSONLine(&p.writeMu, p.stdin, resp)
}

func (p *rpcPeer) sendAsync(method string, params any) (string, <-chan rpcResult, error) {
	idNum := p.nextID.Add(1)
	key := fmt.Sprintf("%d", idNum)
	ch := make(chan rpcResult, 1)

	p.pendingMu.Lock()
	if p.closed {
		p.pendingMu.Unlock()
		return "", nil, errors.New("oar: rpc transport closed")
	}
	p.pending[key] = ch
	p.pendingMu.Unlock()

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      idNum,
		"method":  method,
	}
	if params != nil {
		req["params"] = params
	}
	if err := writeJSONLine(&p.writeMu, p.stdin, req); err != nil {
		p.pendingMu.Lock()
		delete(p.pending, key)
		p.pendingMu.Unlock()
		return "", nil, err
	}
	return key, ch, nil
}

func (p *rpcPeer) cancelPending(key string) {
	if key == "" {
		return
	}
	p.pendingMu.Lock()
	delete(p.pending, key)
	p.pendingMu.Unlock()
}

func (p *rpcPeer) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	key, ch, err := p.sendAsync(method, params)
	if err != nil {
		return nil, err
	}

	select {
	case <-ctx.Done():
		p.cancelPending(key)
		return nil, ctx.Err()
	case res := <-ch:
		return res.result, res.err
	}
}

func (p *rpcPeer) notify(method string, params any) error {
	msg := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
	}
	if params != nil {
		msg["params"] = params
	}
	return writeJSONLine(&p.writeMu, p.stdin, msg)
}

func (p *rpcPeer) failAllPending(cause error) {
	if cause == nil {
		cause = io.EOF
	}
	p.pendingMu.Lock()
	p.closed = true
	for k, ch := range p.pending {
		ch <- rpcResult{err: cause}
		delete(p.pending, k)
	}
	p.pendingMu.Unlock()
}

func normalizeRPCID(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return string(raw)
}
