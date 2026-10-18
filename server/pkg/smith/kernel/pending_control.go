package kernel

import (
	"context"
	"sync"

	"vibevalley/pkg/smith/oar"
)

// PendingControl is the Go asynchronous form of Control (shared/session-kernel.ts): the kernel owns reachability,
// request identity, exactly one response, and its waiter. Native transport parsing and fallbacks stay in the adapter.
type PendingControl struct {
	request oar.RawEvent
	kernel  *Kernel
	at      RecordAt
	mu      sync.Mutex
	result  oar.ControlResult
	done    chan struct{}
	settled bool
}

func (k *Kernel) BeginControl(body oar.RequestBody, at RecordAt) *PendingControl {
	blocked := k.Unreachable()
	p := &PendingControl{kernel: k, at: RecordAt{SessionID: at.SessionID, AgentPath: at.AgentPath, SpanID: at.SpanID}, done: make(chan struct{})}
	p.request = k.Request(oar.ToRuntime, body, at)
	if blocked != nil {
		p.Settle(*blocked)
	} else if empty := EmptyInputRefusal(body); empty != nil {
		p.Settle(*empty)
	}
	return p
}

func (p *PendingControl) Request() oar.RawEvent { return p.request }

func (p *PendingControl) Settled() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.settled
}

// Settle returns false for a late answer; adapters may retain that native answer as a frame.
func (p *PendingControl) Settle(body oar.ResponseBody) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.settled {
		return false
	}
	p.result = oar.ControlResult{Request: p.request, Response: p.kernel.Respond(p.request.ID, body, p.at)}
	p.settled = true
	close(p.done)
	return true
}

// Canceling a waiter does not cancel the native operation or invent a response.
func (p *PendingControl) Wait(ctx context.Context) (oar.ControlResult, error) {
	select {
	case <-p.done:
		return p.result, nil
	default:
	}
	select {
	case <-p.done:
		return p.result, nil
	case <-ctx.Done():
		return oar.ControlResult{}, ctx.Err()
	}
}
