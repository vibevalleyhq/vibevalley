package pi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
)

// rpcClient speaks pi's RPC mode (pi 1.1.0 docs/rpc.md): JSONL commands on
// stdin, `response` records correlated by id and session events on stdout.
//
// The line reader routes a response to its waiting caller at once and queues
// everything else for one processor goroutine, in stdout order. So the
// processor can itself wait for a command's answer (the context reading at
// agent_settled) without blocking the reader that delivers it, and the
// records keep the wire's order.
type rpcClient struct {
	process *executable.LineProcess

	mu      sync.Mutex
	next    int
	pending map[string]chan rpcAnswer
	queue   []queued
	wake    chan struct{}
	exited  bool
}

type rpcAnswer struct {
	data    json.RawMessage
	success bool
	err     string
	code    string
	native  json.RawMessage
	exited  bool
}

// queued is a stdout line for the processor, or the process exit (exit set).
type queued struct {
	line string
	exit bool
	code *int
}

// errExited: the process ended before it answered.
var errExited = errors.New("pi exited")

func newRPCClient(process *executable.LineProcess) *rpcClient {
	client := &rpcClient{process: process, pending: map[string]chan rpcAnswer{}, wake: make(chan struct{}, 1)}
	process.OnLine(client.receive)
	process.OnExit(func(code *int) {
		client.mu.Lock()
		client.exited = true
		pending := client.pending
		client.pending = map[string]chan rpcAnswer{}
		client.queue = append(client.queue, queued{exit: true, code: code})
		client.mu.Unlock()
		for _, answer := range pending {
			answer <- rpcAnswer{exited: true}
		}
		client.signal()
	})
	return client
}

func (c *rpcClient) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *rpcClient) receive(line string) {
	var probe struct {
		Type    string          `json:"type"`
		ID      *string         `json:"id"`
		Success bool            `json:"success"`
		Error   string          `json:"error"`
		Code    string          `json:"code"`
		Native  json.RawMessage `json:"native"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal([]byte(line), &probe) == nil && probe.Type == "response" && probe.ID != nil {
		c.mu.Lock()
		answer, ok := c.pending[*probe.ID]
		delete(c.pending, *probe.ID)
		c.mu.Unlock()
		if ok {
			answer <- rpcAnswer{data: probe.Data, success: probe.Success, err: probe.Error, code: probe.Code, native: probe.Native}
			return
		}
	}
	c.mu.Lock()
	c.queue = append(c.queue, queued{line: line})
	c.mu.Unlock()
	c.signal()
}

// take blocks until the processor has a queued item.
func (c *rpcClient) take() queued {
	for {
		c.mu.Lock()
		if len(c.queue) > 0 {
			item := c.queue[0]
			c.queue = c.queue[1:]
			c.mu.Unlock()
			return item
		}
		c.mu.Unlock()
		<-c.wake
	}
}

// send writes one command without waiting for its answer.
func (c *rpcClient) send(command jsonx.Record) {
	encoded, _ := json.Marshal(command)
	c.process.Write(string(encoded) + "\n")
}

// request sends a command and waits for its response. A failed command
// answers an error carrying pi's message.
func (c *rpcClient) request(ctx context.Context, command jsonx.Record) (json.RawMessage, error) {
	c.mu.Lock()
	if c.exited {
		c.mu.Unlock()
		return nil, errExited
	}
	c.next++
	id := "oar-" + strconv.Itoa(c.next)
	answer := make(chan rpcAnswer, 1)
	c.pending[id] = answer
	c.mu.Unlock()
	copied := jsonx.Record{"id": id}
	for key, value := range command {
		copied[key] = value
	}
	c.send(copied)
	select {
	case got := <-answer:
		if got.exited {
			return nil, errExited
		}
		if !got.success {
			if got.err == "" {
				got.err = fmt.Sprintf("pi refused %v", command["type"])
			}
			return nil, &commandError{message: got.err, code: got.code, native: got.native}
		}
		return got.data, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

// commandError is pi's own refusal of a command (`success: false`); the host
// adds a code for the typed open failures.
type commandError struct {
	message string
	code    string
	native  json.RawMessage
}

func (e *commandError) Error() string { return e.message }
