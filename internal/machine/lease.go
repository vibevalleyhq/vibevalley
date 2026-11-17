package machine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	ErrLeaseNotFound = errors.New("machine: lease not found")
	ErrLeaseExpired  = errors.New("machine: lease expired")
	ErrNoMatchingTag = errors.New("machine: no machine matches required labels")
)

// Lease identifies a bound session workspace on a vibe-machine node.
type Lease struct {
	ID         string    `json:"id"`
	SessionID  string    `json:"sessionId"`
	MachineID  string    `json:"machineId"`
	EnvID      string    `json:"envId"`
	WorkDir    string    `json:"workDir"`
	Repo       string    `json:"repo,omitempty"`
	Labels     []string  `json:"labels,omitempty"`
	AcquiredAt time.Time `json:"acquiredAt"`
	ExpiresAt  time.Time `json:"expiresAt,omitempty"`
}

// LeaseRequest specifies repository and capability constraints for lazy workspace binding.
type LeaseRequest struct {
	SessionID      string        `json:"sessionId"`
	Repo           string        `json:"repo,omitempty"`
	RequiredLabels []string      `json:"requiredLabels,omitempty"`
	TTL            time.Duration `json:"ttl,omitempty"`
}

// LeaseAcquirer provisions and releases ExecutionEnv instances on demand.
type LeaseAcquirer interface {
	Acquire(ctx context.Context, req LeaseRequest) (Lease, contract.ExecutionEnv, error)
	Release(ctx context.Context, lease Lease) error
}

// LazyEnv defers workspace lease acquisition until the first file, exec, mount, or harvest call.
// Pure chat turns that never touch tools incur zero lease latency and allocate zero workspaces.
type LazyEnv struct {
	req      LeaseRequest
	acquirer LeaseAcquirer

	mu          sync.Mutex
	acquired    bool
	closed      bool
	acquiringCh chan struct{}
	lease       Lease
	env         contract.ExecutionEnv
}

var _ contract.ExecutionEnv = (*LazyEnv)(nil)

// NewLazyEnv creates a lazy ExecutionEnv that does not contact any machine until first tool use.
func NewLazyEnv(req LeaseRequest, acquirer LeaseAcquirer) *LazyEnv {
	return &LazyEnv{
		req:      req,
		acquirer: acquirer,
	}
}

// HasLease reports whether a workspace lease has been provisioned yet.
func (l *LazyEnv) HasLease() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.acquired
}

// Lease returns the active lease if one has been acquired.
func (l *LazyEnv) Lease() (Lease, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.acquired {
		return Lease{}, false
	}
	return l.lease, true
}

func (l *LazyEnv) ensureEnv(ctx context.Context) (contract.ExecutionEnv, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if l.acquirer == nil {
		return nil, errors.New("machine: nil lease acquirer")
	}

	for {
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			return nil, ErrEnvClosed
		}
		if l.acquired {
			env := l.env
			l.mu.Unlock()
			return env, nil
		}
		if l.acquiringCh != nil {
			ch := l.acquiringCh
			l.mu.Unlock()
			select {
			case <-ch:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		ch := make(chan struct{})
		l.acquiringCh = ch
		req := l.req
		l.mu.Unlock()

		lease, env, err := l.acquirer.Acquire(ctx, req)

		l.mu.Lock()
		closedDuringAcquire := l.closed
		if err == nil && !closedDuringAcquire {
			l.lease = lease
			l.env = env
			l.acquired = true
		}
		l.acquiringCh = nil
		close(ch)
		l.mu.Unlock()

		if closedDuringAcquire {
			if err == nil && env != nil {
				_ = env.Close()
				_ = l.acquirer.Release(context.Background(), lease)
			}
			return nil, ErrEnvClosed
		}
		if err != nil {
			return nil, err
		}
		return env, nil
	}
}

func (l *LazyEnv) WriteAtomic(ctx context.Context, relPath string, data []byte, perm uint32) error {
	env, err := l.ensureEnv(ctx)
	if err != nil {
		return err
	}
	return env.WriteAtomic(ctx, relPath, data, perm)
}

func (l *LazyEnv) EditPatch(ctx context.Context, relPath string, oldText string, newText string) error {
	env, err := l.ensureEnv(ctx)
	if err != nil {
		return err
	}
	return env.EditPatch(ctx, relPath, oldText, newText)
}

func (l *LazyEnv) ReadFile(ctx context.Context, relPath string) ([]byte, error) {
	env, err := l.ensureEnv(ctx)
	if err != nil {
		return nil, err
	}
	return env.ReadFile(ctx, relPath)
}

func (l *LazyEnv) Exec(ctx context.Context, spec contract.ExecSpec) (contract.ExecResult, error) {
	env, err := l.ensureEnv(ctx)
	if err != nil {
		return contract.ExecResult{}, err
	}
	return env.Exec(ctx, spec)
}

func (l *LazyEnv) SyncMounts(ctx context.Context, req contract.MountSyncRequest) (contract.MountSyncResult, error) {
	env, err := l.ensureEnv(ctx)
	if err != nil {
		return contract.MountSyncResult{}, err
	}
	return env.SyncMounts(ctx, req)
}

func (l *LazyEnv) HarvestOutputs(ctx context.Context) ([]contract.HarvestedOutput, error) {
	env, err := l.ensureEnv(ctx)
	if err != nil {
		return nil, err
	}
	return env.HarvestOutputs(ctx)
}

// Close releases the underlying environment only if one was acquired.
func (l *LazyEnv) Close() error {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	acquired := l.acquired
	lease := l.lease
	env := l.env
	l.mu.Unlock()

	if !acquired {
		return nil
	}
	var errs []error
	if env != nil {
		if err := env.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if l.acquirer != nil {
		if err := l.acquirer.Release(context.Background(), lease); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// LeaseTrackerConfig configures local workspace lease provisioning under WorkRoot.
type LeaseTrackerConfig struct {
	MachineID       string
	WorkRoot        string
	Labels          []string
	Locks           *PathLocks
	ExecGracePeriod time.Duration
	MountRemote     MountRemote
	Now             func() time.Time
}

type activeLease struct {
	lease Lease
	env   *LocalEnv
}

// LeaseTracker provisions, tracks, and tears down session workspace leases on a machine.
type LeaseTracker struct {
	machineID   string
	workRoot    string
	labels      map[string]struct{}
	labelList   []string
	locks       *PathLocks
	execGrace   time.Duration
	mountRemote MountRemote
	now         func() time.Time

	mu     sync.Mutex
	leases map[string]*activeLease
	closed bool
}

var _ LeaseAcquirer = (*LeaseTracker)(nil)

// NewLeaseTracker creates a LeaseTracker anchored at cfg.WorkRoot without creating session directories eagerly.
func NewLeaseTracker(cfg LeaseTrackerConfig) (*LeaseTracker, error) {
	if strings.TrimSpace(cfg.WorkRoot) == "" {
		return nil, fmt.Errorf("%w: empty workRoot", ErrInvalidPath)
	}
	absRoot, err := filepath.Abs(cfg.WorkRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve workRoot: %w", err)
	}
	locks := cfg.Locks
	if locks == nil {
		locks = NewPathLocks()
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	labelSet := make(map[string]struct{}, len(cfg.Labels))
	var labelList []string
	for _, lbl := range cfg.Labels {
		trimmed := strings.TrimSpace(lbl)
		if trimmed == "" {
			continue
		}
		if _, dup := labelSet[trimmed]; !dup {
			labelSet[trimmed] = struct{}{}
			labelList = append(labelList, trimmed)
		}
	}
	machineID := strings.TrimSpace(cfg.MachineID)
	if machineID == "" {
		machineID = "machine-local"
	}
	return &LeaseTracker{
		machineID:   machineID,
		workRoot:    absRoot,
		labels:      labelSet,
		labelList:   labelList,
		locks:       locks,
		execGrace:   cfg.ExecGracePeriod,
		mountRemote: cfg.MountRemote,
		now:         now,
		leases:      make(map[string]*activeLease),
	}, nil
}

// MatchesLabels reports whether this machine satisfies all required capability labels.
func (t *LeaseTracker) MatchesLabels(required []string) bool {
	for _, req := range required {
		req = strings.TrimSpace(req)
		if req == "" {
			continue
		}
		if _, ok := t.labels[req]; !ok {
			return false
		}
	}
	return true
}

// Acquire provisions a workspace directory and LocalEnv for req when first needed.
func (t *LeaseTracker) Acquire(ctx context.Context, req LeaseRequest) (Lease, contract.ExecutionEnv, error) {
	if err := ctx.Err(); err != nil {
		return Lease{}, nil, err
	}
	if !t.MatchesLabels(req.RequiredLabels) {
		return Lease{}, nil, fmt.Errorf("%w: required %v", ErrNoMatchingTag, req.RequiredLabels)
	}

	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return Lease{}, nil, ErrEnvClosed
	}

	sessionSeg := sanitizePathSegment(req.SessionID, "session")
	leaseID := newLeaseID()
	envID := t.machineID + ":" + sessionSeg + ":" + leaseID
	workDir := filepath.Join(t.workRoot, sessionSeg, leaseID)
	t.mu.Unlock()

	env, err := NewLocalEnv(LocalEnvConfig{
		EnvID:           envID,
		WorkDir:         workDir,
		Locks:           t.locks,
		ExecGracePeriod: t.execGrace,
		MountRemote:     t.mountRemote,
	})
	if err != nil {
		return Lease{}, nil, err
	}

	now := t.now()
	var expiresAt time.Time
	if req.TTL > 0 {
		expiresAt = now.Add(req.TTL)
	}
	lease := Lease{
		ID:         leaseID,
		SessionID:  req.SessionID,
		MachineID:  t.machineID,
		EnvID:      envID,
		WorkDir:    env.RootDir(),
		Repo:       req.Repo,
		Labels:     append([]string(nil), t.labelList...),
		AcquiredAt: now,
		ExpiresAt:  expiresAt,
	}

	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		_ = env.Close()
		return Lease{}, nil, ErrEnvClosed
	}
	t.leases[lease.ID] = &activeLease{lease: lease, env: env}
	t.mu.Unlock()

	return lease, env, nil
}

// Release removes lease tracking and closes its LocalEnv if still active.
func (t *LeaseTracker) Release(_ context.Context, lease Lease) error {
	t.mu.Lock()
	entry, ok := t.leases[lease.ID]
	if ok {
		delete(t.leases, lease.ID)
	}
	t.mu.Unlock()

	if !ok {
		return nil
	}
	return entry.env.Close()
}

// Get returns a currently active lease and its LocalEnv by leaseID.
func (t *LeaseTracker) Get(leaseID string) (Lease, *LocalEnv, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.leases[leaseID]
	if !ok {
		return Lease{}, nil, false
	}
	if !entry.lease.ExpiresAt.IsZero() && t.now().After(entry.lease.ExpiresAt) {
		return Lease{}, nil, false
	}
	return entry.lease, entry.env, true
}

// Renew extends an active lease's expiration timestamp.
func (t *LeaseTracker) Renew(leaseID string, ttl time.Duration) (Lease, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.leases[leaseID]
	if !ok {
		return Lease{}, ErrLeaseNotFound
	}
	now := t.now()
	if !entry.lease.ExpiresAt.IsZero() && now.After(entry.lease.ExpiresAt) {
		return Lease{}, ErrLeaseExpired
	}
	if ttl > 0 {
		entry.lease.ExpiresAt = now.Add(ttl)
	} else {
		entry.lease.ExpiresAt = time.Time{}
	}
	return entry.lease, nil
}

// List returns a snapshot of all tracked leases.
func (t *LeaseTracker) List() []Lease {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]Lease, 0, len(t.leases))
	for _, entry := range t.leases {
		out = append(out, entry.lease)
	}
	return out
}

// DisconnectAll propagates link loss to all active leased environments so running Exec trees terminate cleanly.
func (t *LeaseTracker) DisconnectAll(cause error) {
	t.mu.Lock()
	envs := make([]*LocalEnv, 0, len(t.leases))
	for _, entry := range t.leases {
		envs = append(envs, entry.env)
	}
	t.mu.Unlock()

	for _, env := range envs {
		env.Disconnect(cause)
	}
}

// ReconnectAll restores execution lifecycles on active leases after link recovery.
func (t *LeaseTracker) ReconnectAll() {
	t.mu.Lock()
	envs := make([]*LocalEnv, 0, len(t.leases))
	for _, entry := range t.leases {
		envs = append(envs, entry.env)
	}
	t.mu.Unlock()

	for _, env := range envs {
		env.ResetLink()
	}
}

// CloseAll shuts down the tracker and closes every active leased LocalEnv.
func (t *LeaseTracker) CloseAll() error {
	t.mu.Lock()
	t.closed = true
	entries := make([]*activeLease, 0, len(t.leases))
	for id, entry := range t.leases {
		entries = append(entries, entry)
		delete(t.leases, id)
	}
	t.mu.Unlock()

	var errs []error
	for _, entry := range entries {
		if err := entry.env.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func sanitizePathSegment(raw, fallback string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallback
	}
	var b strings.Builder
	b.Grow(len(trimmed))
	for _, r := range trimmed {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	cleaned := strings.Trim(b.String(), ".")
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return fallback
	}
	return cleaned
}

func newLeaseID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("lease-%d", time.Now().UnixNano())
	}
	return "lease-" + hex.EncodeToString(b[:])
}
