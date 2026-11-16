package oar

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

var (
	// ErrSubagentDepthExceeded indicates spawning was blocked by OAR_SUBAGENT_DEPTH.
	ErrSubagentDepthExceeded = errors.New("oar: subagent depth limit exceeded")
	// ErrSubagentConcurrencyCap indicates all concurrent subagent slots are occupied.
	ErrSubagentConcurrencyCap = errors.New("oar: subagent concurrency cap reached")
	// ErrInvalidSubagentDepth indicates OAR_SUBAGENT_DEPTH holds a malformed value.
	ErrInvalidSubagentDepth = errors.New("oar: invalid OAR_SUBAGENT_DEPTH value")
	// ErrSubagentPoolClosed indicates the pool has been closed.
	ErrSubagentPoolClosed = errors.New("oar: subagent pool closed")
)

// SubagentRefusalError describes why a subagent spawn was refused before opening a runtime session.
type SubagentRefusalError struct {
	Code    string
	Reason  string
	Depth   int
	Max     int
	Running int
	Cap     int
	Cause   error
}

func (e *SubagentRefusalError) Error() string {
	return fmt.Sprintf("oar: subagent refused (%s): %s", e.Code, e.Reason)
}

func (e *SubagentRefusalError) Unwrap() error {
	return e.Cause
}

// SubagentPoolConfig configures depth and concurrency guardrails for spawned subagents.
type SubagentPoolConfig struct {
	Drivers *Registry
	// MaxDepth limits nested spawning via OAR_SUBAGENT_DEPTH. Zero uses DefaultMaxSubagentDepth (1).
	// Negative disables spawning completely (effective limit 0).
	MaxDepth int
	// MaxConcurrent limits simultaneous active subagent sessions. Zero or negative uses DefaultMaxSubagentConcurrency (4).
	MaxConcurrent int
	// CurrentDepth overrides process OAR_SUBAGENT_DEPTH lookup when non-nil.
	CurrentDepth *int
}

// SubagentRequest describes one delegated subagent session to spawn under pool limits.
type SubagentRequest struct {
	ID      string
	Runtime string
	Options SessionOptions
}

// SubagentStats reports current depth and slot occupancy for observability and tests.
type SubagentStats struct {
	CurrentDepth  int
	MaxDepth      int
	Active        int
	MaxConcurrent int
}

// SubagentPool enforces OAR_SUBAGENT_DEPTH recursion limits and concurrent subagent caps.
type SubagentPool struct {
	drivers       *Registry
	maxDepth      int
	maxConcurrent int
	currentDepth  *int

	mu      sync.Mutex
	closed  bool
	active  map[uint64]*managedSubagent
	nextSeq atomic.Uint64
}

// NewSubagentPool constructs a pool enforcing DefaultMaxSubagentDepth (1) and DefaultMaxSubagentConcurrency (4) by default.
func NewSubagentPool(cfg SubagentPoolConfig) *SubagentPool {
	maxDepth := cfg.MaxDepth
	if maxDepth == 0 {
		maxDepth = DefaultMaxSubagentDepth
	} else if maxDepth < 0 {
		maxDepth = 0
	}
	maxConcurrent := cfg.MaxConcurrent
	if maxConcurrent <= 0 {
		maxConcurrent = DefaultMaxSubagentConcurrency
	}
	drivers := cfg.Drivers
	if drivers == nil {
		drivers = DefaultRegistry()
	}
	return &SubagentPool{
		drivers:       drivers,
		maxDepth:      maxDepth,
		maxConcurrent: maxConcurrent,
		currentDepth:  cfg.CurrentDepth,
		active:        make(map[uint64]*managedSubagent),
	}
}

// Stats returns the current depth and concurrency occupancy.
func (p *SubagentPool) Stats() (SubagentStats, error) {
	depth, err := p.effectiveDepth(nil)
	if err != nil {
		return SubagentStats{}, err
	}
	p.mu.Lock()
	active := len(p.active)
	p.mu.Unlock()
	return SubagentStats{
		CurrentDepth:  depth,
		MaxDepth:      p.maxDepth,
		Active:        active,
		MaxConcurrent: p.maxConcurrent,
	}, nil
}

// Spawn enforces depth and concurrency guardrails, injects incremented OAR_SUBAGENT_DEPTH,
// and opens the child runtime session. Disposing the returned Session releases its slot.
func (p *SubagentPool) Spawn(ctx context.Context, req SubagentRequest) (Session, error) {
	driver, ok := p.drivers.Get(req.Runtime)
	if !ok {
		return nil, fmt.Errorf("oar: unknown runtime %q", req.Runtime)
	}

	depth, err := p.effectiveDepth(req.Options.BaseEnv)
	if err != nil {
		return nil, err
	}
	if depth >= p.maxDepth {
		return nil, &SubagentRefusalError{
			Code:   "depth_limit",
			Reason: fmt.Sprintf("OAR_SUBAGENT_DEPTH=%d reached limit %d", depth, p.maxDepth),
			Depth:  depth,
			Max:    p.maxDepth,
			Cause:  ErrSubagentDepthExceeded,
		}
	}

	slotID := p.nextSeq.Add(1)
	placeholder := &managedSubagent{pool: p, slotID: slotID}

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrSubagentPoolClosed
	}
	if len(p.active) >= p.maxConcurrent {
		running := len(p.active)
		p.mu.Unlock()
		return nil, &SubagentRefusalError{
			Code:    "concurrency_limit",
			Reason:  fmt.Sprintf("%d/%d concurrent subagents already active", running, p.maxConcurrent),
			Running: running,
			Cap:     p.maxConcurrent,
			Cause:   ErrSubagentConcurrencyCap,
		}
	}
	p.active[slotID] = placeholder
	p.mu.Unlock()

	childOpts := req.Options
	childOpts.BaseEnv = withEnvVar(childOpts.BaseEnv, EnvSubagentDepth, strconv.Itoa(depth+1))
	if len(childOpts.Env) > 0 {
		clonedEnv := make(map[string]string, len(childOpts.Env))
		for k, v := range childOpts.Env {
			if k == EnvSubagentDepth {
				continue
			}
			clonedEnv[k] = v
		}
		if len(clonedEnv) == 0 {
			childOpts.Env = nil
		} else {
			childOpts.Env = clonedEnv
		}
	}

	sess, err := driver.Open(ctx, childOpts)
	if err != nil {
		p.releaseSlot(slotID)
		return nil, err
	}

	placeholder.bind(sess)
	return placeholder, nil
}

// Close disposes all active subagent sessions and prevents future spawns.
func (p *SubagentPool) Close(ctx context.Context) error {
	p.mu.Lock()
	p.closed = true
	items := make([]*managedSubagent, 0, len(p.active))
	for _, item := range p.active {
		items = append(items, item)
	}
	p.mu.Unlock()

	var firstErr error
	for _, item := range items {
		if err := item.Dispose(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (p *SubagentPool) releaseSlot(slotID uint64) {
	p.mu.Lock()
	delete(p.active, slotID)
	p.mu.Unlock()
}

func (p *SubagentPool) effectiveDepth(baseEnv []string) (int, error) {
	if p.currentDepth != nil {
		if *p.currentDepth < 0 {
			return 0, &SubagentRefusalError{
				Code:   "invalid_depth",
				Reason: fmt.Sprintf("negative depth %d", *p.currentDepth),
				Depth:  *p.currentDepth,
				Max:    p.maxDepth,
				Cause:  ErrInvalidSubagentDepth,
			}
		}
		return *p.currentDepth, nil
	}
	raw, ok := lookupEnv(baseEnv, EnvSubagentDepth)
	if !ok {
		raw = os.Getenv(EnvSubagentDepth)
	}
	return ParseSubagentDepth(raw)
}

// ParseSubagentDepth parses an OAR_SUBAGENT_DEPTH value; unset/empty returns 0.
func ParseSubagentDepth(raw string) (int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(trimmed)
	if err != nil || n < 0 {
		return 0, &SubagentRefusalError{
			Code:   "invalid_depth",
			Reason: fmt.Sprintf("invalid %s=%q", EnvSubagentDepth, raw),
			Cause:  ErrInvalidSubagentDepth,
		}
	}
	return n, nil
}

func lookupEnv(env []string, key string) (string, bool) {
	prefix := key + "="
	val := ""
	found := false
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			val = strings.TrimPrefix(entry, prefix)
			found = true
		}
	}
	return val, found
}

func withEnvVar(baseEnv []string, key, value string) []string {
	src := baseEnv
	if src == nil {
		src = os.Environ()
	}
	prefix := key + "="
	out := make([]string, 0, len(src)+1)
	for _, kv := range src {
		if !strings.HasPrefix(kv, prefix) {
			out = append(out, kv)
		}
	}
	out = append(out, prefix+value)
	return out
}

type managedSubagent struct {
	pool        *SubagentPool
	slotID      uint64
	mu          sync.RWMutex
	inner       Session
	releaseOnce sync.Once
}

func (m *managedSubagent) bind(s Session) {
	m.mu.Lock()
	m.inner = s
	m.mu.Unlock()
}

func (m *managedSubagent) release() {
	m.releaseOnce.Do(func() {
		m.pool.releaseSlot(m.slotID)
	})
}

func (m *managedSubagent) session() Session {
	m.mu.RLock()
	s := m.inner
	m.mu.RUnlock()
	return s
}

func (m *managedSubagent) ID() string      { return m.session().ID() }
func (m *managedSubagent) Runtime() string { return m.session().Runtime() }
func (m *managedSubagent) Prompt(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	return m.session().Prompt(ctx, input, opts...)
}
func (m *managedSubagent) Steer(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	return m.session().Steer(ctx, input, opts...)
}
func (m *managedSubagent) Queue(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	return m.session().Queue(ctx, input, opts...)
}
func (m *managedSubagent) Withdraw(ctx context.Context, inputID string) (ControlOutcome, error) {
	return m.session().Withdraw(ctx, inputID)
}
func (m *managedSubagent) Abort(ctx context.Context) (ControlOutcome, error) {
	return m.session().Abort(ctx)
}
func (m *managedSubagent) Compact(ctx context.Context) (ControlOutcome, error) {
	return m.session().Compact(ctx)
}
func (m *managedSubagent) StopTask(ctx context.Context, taskID string) (ControlOutcome, error) {
	return m.session().StopTask(ctx, taskID)
}
func (m *managedSubagent) Control(ctx context.Context, action ControlAction, arg string, opts ...InputOption) (ControlOutcome, error) {
	return m.session().Control(ctx, action, arg, opts...)
}
func (m *managedSubagent) Records() []RecordEnvelope { return m.session().Records() }
func (m *managedSubagent) Subscribe(afterSeq int64, fn func(RecordEnvelope)) func() {
	return m.session().Subscribe(afterSeq, fn)
}
func (m *managedSubagent) Usage() *TokenTotals { return m.session().Usage() }

func (m *managedSubagent) Wait(ctx context.Context) error {
	err := m.session().Wait(ctx)
	if ctx.Err() == nil {
		m.release()
	}
	return err
}

func (m *managedSubagent) Dispose(ctx context.Context) error {
	defer m.release()
	s := m.session()
	if s == nil {
		return nil
	}
	return s.Dispose(ctx)
}
