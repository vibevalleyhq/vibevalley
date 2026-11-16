package stack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	// ErrNoMachineAvailable is returned when no connected online vibe-machine satisfies the lease labels.
	ErrNoMachineAvailable = errors.New("stack: no matching machine online")
	// ErrMachineOffline is returned when an operation targets a disconnected machine.
	ErrMachineOffline = errors.New("stack: machine offline")
)

// LeaseStatus captures the server-side broker lifecycle of a remote machine lease.
type LeaseStatus string

const (
	LeaseActive       LeaseStatus = "active"
	LeaseReleased     LeaseStatus = "released"
	LeaseDisconnected LeaseStatus = "disconnected"
)

// LeaseRecord tracks an acquired remote lease on the hub across connect/release/disconnect transitions.
type LeaseRecord struct {
	Lease       machine.Lease `json:"lease"`
	MachineID   string        `json:"machineId"`
	SessionID   string        `json:"sessionId"`
	Status      LeaseStatus   `json:"status"`
	UpdatedAtMs int64         `json:"updatedAtMs"`
}

// MachineInfo summarizes a connected remote vibe-machine node.
type MachineInfo struct {
	MachineID  string              `json:"machineId"`
	WorkRoot   string              `json:"workRoot,omitempty"`
	Labels     []string            `json:"labels,omitempty"`
	MCPTargets []machine.MCPTarget `json:"mcpTargets,omitempty"`
}

// RemoteMachine represents one authenticated outbound vibe-machine connection over Chord Link.
type RemoteMachine struct {
	ID         string
	Labels     []string
	WorkRoot   string
	MCPTargets []machine.MCPTarget
	Link       *link.Link
}

// MachineHub terminates outbound vibe-machine Chord Link WebSockets and brokers lazy leases,
// mount synchronization, output ingestion, and MCP reverse tunneling.
type MachineHub struct {
	stack        *Stack
	auth         link.Authenticator
	mu           sync.RWMutex
	machines     map[string]*RemoteMachine
	leases       map[string]LeaseRecord
	stateChanged chan struct{}
}

func newMachineHub(stack *Stack, customAuth link.Authenticator) *MachineHub {
	return &MachineHub{
		stack:        stack,
		auth:         customAuth,
		machines:     make(map[string]*RemoteMachine),
		leases:       make(map[string]LeaseRecord),
		stateChanged: make(chan struct{}),
	}
}

func (h *MachineHub) notifyLocked() {
	close(h.stateChanged)
	h.stateChanged = make(chan struct{})
}

func (h *MachineHub) stateSignal() <-chan struct{} {
	h.mu.RLock()
	ch := h.stateChanged
	h.mu.RUnlock()
	return ch
}

// HandleWebSocket upgrades an HTTP request on /machine/ws into a reverse Chord Link for vibe-machine.
func (h *MachineHub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	tr, err := link.UpgradeWebSocket(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := h.ServeTransport(r.Context(), tr); err != nil {
		_ = tr.Close()
		return
	}
}

// ServeTransport executes the Chord Link PrincipalMachineNode handshake on transport,
// registers the remote machine online, and monitors disconnect until ctx or link termination.
func (h *MachineHub) ServeTransport(ctx context.Context, transport link.FrameTransport) (*RemoteMachine, error) {
	if h.stack.closed.Load() {
		return nil, ErrClosed
	}
	if ctx == nil {
		ctx = h.stack.bgCtx
	}

	serverPrincipal := link.Principal{
		Kind: link.PrincipalUserDevice,
		ID:   "vibe-server",
	}
	authFn := func(authCtx context.Context, peer link.Principal) error {
		if peer.Kind != link.PrincipalMachineNode {
			return fmt.Errorf("%w: expected machine_node principal, got %s", link.ErrUnauthorized, peer.Kind)
		}
		if h.auth != nil {
			return h.auth(authCtx, peer)
		}
		return nil
	}

	var rm *RemoteMachine
	var closeOnce sync.Once
	onClosed := func(_ error) {
		closeOnce.Do(func() {
			if rm != nil {
				h.unregisterMachine(rm)
			}
		})
	}

	lnk := link.NewLink(transport, link.Options{
		Principal:    serverPrincipal,
		Authenticate: authFn,
		SidePrefix:   "srv",
		OnClose:      onClosed,
	})
	if err := lnk.Start(ctx); err != nil {
		return nil, err
	}

	peer := lnk.PeerPrincipal()
	rm = &RemoteMachine{
		ID:   peer.ID,
		Link: lnk,
	}

	// Query machine metadata if supported by the remote node.
	var info MachineInfo
	if err := lnk.Call(ctx, "machine.info", map[string]any{}, &info); err == nil {
		if info.MachineID != "" {
			rm.ID = info.MachineID
		}
		rm.WorkRoot = info.WorkRoot
		rm.Labels = slices.Clone(info.Labels)
		rm.MCPTargets = slices.Clone(info.MCPTargets)
	}

	h.registerMachine(rm)

	h.stack.wg.Add(1)
	go func() {
		defer h.stack.wg.Done()
		lnk.Wait()
		onClosed(nil)
	}()

	return rm, nil
}

func (h *MachineHub) registerMachine(rm *RemoteMachine) {
	h.mu.Lock()
	prev := h.machines[rm.ID]
	h.machines[rm.ID] = rm
	h.notifyLocked()
	h.mu.Unlock()

	if prev != nil && prev != rm && prev.Link != nil {
		_ = prev.Link.Close()
	}
	if h.stack.Game != nil {
		_, _ = h.stack.Game.SetMachineOnline(rm.ID, true)
	}
}

func (h *MachineHub) unregisterMachine(rm *RemoteMachine) {
	now := h.stack.clock.NowMs()
	var offline bool

	h.mu.Lock()
	if cur := h.machines[rm.ID]; cur == rm {
		delete(h.machines, rm.ID)
		offline = true
	}
	for id, rec := range h.leases {
		if rec.MachineID == rm.ID && rec.Status == LeaseActive {
			rec.Status = LeaseDisconnected
			rec.UpdatedAtMs = now
			h.leases[id] = rec
		}
	}
	h.notifyLocked()
	h.mu.Unlock()

	if offline && h.stack.Game != nil {
		_, _ = h.stack.Game.SetMachineOnline(rm.ID, false)
	}
}

func (h *MachineHub) closeAll() {
	h.mu.Lock()
	links := make([]*link.Link, 0, len(h.machines))
	for _, rm := range h.machines {
		if rm.Link != nil {
			links = append(links, rm.Link)
		}
	}
	h.mu.Unlock()

	for _, l := range links {
		_ = l.Close()
	}
}

// OnlineIDs returns sorted IDs of all currently connected remote machines.
func (h *MachineHub) OnlineIDs() []string {
	h.mu.RLock()
	ids := make([]string, 0, len(h.machines))
	for id := range h.machines {
		ids = append(ids, id)
	}
	h.mu.RUnlock()
	sort.Strings(ids)
	return ids
}

// ListOnline returns snapshots of all currently connected remote machines.
func (h *MachineHub) ListOnline() []MachineInfo {
	ids := h.OnlineIDs()
	h.mu.RLock()
	out := make([]MachineInfo, 0, len(ids))
	for _, id := range ids {
		if rm := h.machines[id]; rm != nil {
			out = append(out, MachineInfo{
				MachineID:  rm.ID,
				WorkRoot:   rm.WorkRoot,
				Labels:     slices.Clone(rm.Labels),
				MCPTargets: slices.Clone(rm.MCPTargets),
			})
		}
	}
	h.mu.RUnlock()
	return out
}

// WaitOnline blocks deterministically until at least count machines are registered online or ctx expires.
func (h *MachineHub) WaitOnline(ctx context.Context, count int) ([]string, error) {
	if count <= 0 {
		count = 1
	}
	for {
		ch := h.stateSignal()
		ids := h.OnlineIDs()
		if len(ids) >= count {
			return ids, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ch:
		}
	}
}

// GetLease retrieves a tracked remote lease record by ID.
func (h *MachineHub) GetLease(leaseID string) (LeaseRecord, bool) {
	h.mu.RLock()
	rec, ok := h.leases[leaseID]
	h.mu.RUnlock()
	return rec, ok
}

// ListLeases returns all recorded leases, optionally filtered by sessionID.
func (h *MachineHub) ListLeases(sessionID string) []LeaseRecord {
	h.mu.RLock()
	out := make([]LeaseRecord, 0, len(h.leases))
	for _, rec := range h.leases {
		if sessionID == "" || rec.SessionID == sessionID {
			out = append(out, rec)
		}
	}
	h.mu.RUnlock()
	return out
}

// WaitLeaseStatus waits deterministically until leaseID reaches target status or ctx expires.
func (h *MachineHub) WaitLeaseStatus(ctx context.Context, leaseID string, target LeaseStatus) (LeaseRecord, error) {
	for {
		ch := h.stateSignal()
		rec, ok := h.GetLease(leaseID)
		if ok && rec.Status == target {
			return rec, nil
		}
		select {
		case <-ctx.Done():
			return LeaseRecord{}, ctx.Err()
		case <-ch:
		}
	}
}

// NewLazyEnv creates a deferred contract.ExecutionEnv that only acquires a lease on first tool use.
func (h *MachineHub) NewLazyEnv(req machine.LeaseRequest) *machine.LazyEnv {
	return machine.NewLazyEnv(req, h)
}

// Acquire satisfies machine.LeaseAcquirer by selecting an eligible connected machine and reserving a workspace lease.
func (h *MachineHub) Acquire(ctx context.Context, req machine.LeaseRequest) (machine.Lease, contract.ExecutionEnv, error) {
	if h.stack.closed.Load() {
		return machine.Lease{}, nil, ErrClosed
	}
	rm, err := h.pickMachine(req.RequiredLabels)
	if err != nil {
		return machine.Lease{}, nil, err
	}
	var lease machine.Lease
	if err := rm.Link.Call(ctx, "env.lease.acquire", req, &lease); err != nil {
		return machine.Lease{}, nil, err
	}
	if lease.MachineID == "" {
		lease.MachineID = rm.ID
	}

	h.mu.Lock()
	h.leases[lease.ID] = LeaseRecord{
		Lease:       lease,
		MachineID:   rm.ID,
		SessionID:   lease.SessionID,
		Status:      LeaseActive,
		UpdatedAtMs: h.stack.clock.NowMs(),
	}
	h.notifyLocked()
	h.mu.Unlock()

	return lease, &RemoteEnv{
		hub:     h,
		machine: rm,
		lease:   lease,
	}, nil
}

// Release releases a remote lease over Chord Link and updates hub state.
func (h *MachineHub) Release(ctx context.Context, lease machine.Lease) error {
	h.mu.Lock()
	rec, ok := h.leases[lease.ID]
	machineID := lease.MachineID
	if ok && machineID == "" {
		machineID = rec.MachineID
	}
	rm := h.machines[machineID]
	h.mu.Unlock()

	if rm != nil && rm.Link != nil {
		var ack map[string]bool
		if err := rm.Link.Call(ctx, "env.lease.release", map[string]string{"leaseId": lease.ID}, &ack); err != nil {
			return err
		}
	}

	h.mu.Lock()
	if cur, exists := h.leases[lease.ID]; exists {
		cur.Status = LeaseReleased
		cur.UpdatedAtMs = h.stack.clock.NowMs()
		h.leases[lease.ID] = cur
		h.notifyLocked()
	}
	h.mu.Unlock()
	return nil
}

// TunnelHTTP proxies an HTTP/MCP invocation to a registered target inside machineID.
func (h *MachineHub) TunnelHTTP(ctx context.Context, machineID string, req machine.TunnelHTTPRequest) (machine.TunnelHTTPResponse, error) {
	rm, err := h.machineByID(machineID)
	if err != nil {
		return machine.TunnelHTTPResponse{}, err
	}
	var resp machine.TunnelHTTPResponse
	if err := rm.Link.Call(ctx, "mcp.http", req, &resp); err != nil {
		return machine.TunnelHTTPResponse{}, err
	}
	return resp, nil
}

// SyncProfileMounts pushes agent read-only skills and bidirectional memory mounts to env
// and reconciles any uploaded memory changes or conflicts into the server Memory store.
func (h *MachineHub) SyncProfileMounts(ctx context.Context, env contract.ExecutionEnv, scopeID, profileID, sessionID string, extra ...contract.MountFile) (contract.MountSyncResult, error) {
	if h.stack.closed.Load() {
		return contract.MountSyncResult{}, ErrClosed
	}
	if scopeID == "" {
		scopeID = memory.DefaultScopeID
	}
	var skills []contract.MountFile
	if profileID != "" {
		files, err := h.stack.Agents.MountFilesForProfile(ctx, profileID)
		if err != nil && !errors.Is(err, agent.ErrNotFound) {
			return contract.MountSyncResult{}, err
		}
		skills = append(skills, files...)
	}
	memories, err := h.stack.Memory.MaterializeFiles(ctx, scopeID)
	if err != nil {
		return contract.MountSyncResult{}, err
	}
	for _, f := range extra {
		if f.ReadOnly {
			skills = append(skills, f)
		} else {
			memories = append(memories, f)
		}
	}
	res, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: sessionID,
		Skills:    skills,
		Memories:  memories,
		Flush:     true,
	})
	if err != nil {
		return contract.MountSyncResult{}, err
	}
	if len(res.Uploaded) > 0 {
		if _, _, rErr := h.stack.Memory.ReconcileMounts(ctx, scopeID, sessionID, res.Uploaded); rErr != nil {
			return res, rErr
		}
	}
	return res, nil
}

// HarvestToMedia harvests .vibe/outputs/ from env and ingests them SHA-256 deduplicated into domain/media.
func (h *MachineHub) HarvestToMedia(ctx context.Context, env contract.ExecutionEnv, meta media.IngestMetadata) (media.IngestResult, error) {
	if h.stack.closed.Load() {
		return media.IngestResult{}, ErrClosed
	}
	return h.stack.Media.HarvestAndIngest(ctx, env, meta)
}

func (h *MachineHub) machineByID(machineID string) (*RemoteMachine, error) {
	h.mu.RLock()
	rm, ok := h.machines[machineID]
	h.mu.RUnlock()
	if !ok || rm == nil {
		return nil, fmt.Errorf("%w: %s", ErrMachineOffline, machineID)
	}
	return rm, nil
}

func (h *MachineHub) pickMachine(required []string) (*RemoteMachine, error) {
	ids := h.OnlineIDs()
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, id := range ids {
		rm := h.machines[id]
		if rm == nil {
			continue
		}
		if hasAllLabels(rm.Labels, required) {
			return rm, nil
		}
	}
	return nil, ErrNoMachineAvailable
}

func hasAllLabels(have, required []string) bool {
	if len(required) == 0 {
		return true
	}
	set := make(map[string]struct{}, len(have))
	for _, l := range have {
		set[l] = struct{}{}
	}
	for _, req := range required {
		if _, ok := set[req]; !ok {
			return false
		}
	}
	return true
}

// RemoteEnv implements contract.ExecutionEnv backed by RPCs over a Chord Link to vibe-machine.
type RemoteEnv struct {
	hub       *MachineHub
	machine   *RemoteMachine
	lease     machine.Lease
	closeOnce sync.Once
}

// Lease returns the bound remote machine lease metadata.
func (e *RemoteEnv) Lease() machine.Lease { return e.lease }

func (e *RemoteEnv) WriteAtomic(ctx context.Context, relPath string, data []byte, perm uint32) error {
	var ack map[string]bool
	return e.machine.Link.Call(ctx, "env.write", map[string]any{
		"leaseId": e.lease.ID,
		"relPath": relPath,
		"data":    data,
		"perm":    perm,
	}, &ack)
}

func (e *RemoteEnv) EditPatch(ctx context.Context, relPath, oldText, newText string) error {
	var ack map[string]bool
	return e.machine.Link.Call(ctx, "env.edit", map[string]any{
		"leaseId": e.lease.ID,
		"relPath": relPath,
		"oldText": oldText,
		"newText": newText,
	}, &ack)
}

func (e *RemoteEnv) ReadFile(ctx context.Context, relPath string) ([]byte, error) {
	var out struct {
		Data []byte `json:"data"`
	}
	if err := e.machine.Link.Call(ctx, "env.read", map[string]any{
		"leaseId": e.lease.ID,
		"relPath": relPath,
	}, &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}

func (e *RemoteEnv) Exec(ctx context.Context, spec contract.ExecSpec) (contract.ExecResult, error) {
	var raw json.RawMessage
	if err := e.machine.Link.Call(ctx, "env.exec", map[string]any{
		"leaseId": e.lease.ID,
		"spec":    spec,
	}, &raw); err != nil {
		return contract.ExecResult{}, err
	}
	var res struct {
		contract.ExecResult
		Error string `json:"error,omitempty"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return contract.ExecResult{}, err
	}
	if res.Error != "" {
		return res.ExecResult, errors.New(res.Error)
	}
	return res.ExecResult, nil
}

func (e *RemoteEnv) SyncMounts(ctx context.Context, req contract.MountSyncRequest) (contract.MountSyncResult, error) {
	var res contract.MountSyncResult
	err := e.machine.Link.Call(ctx, "env.sync", map[string]any{
		"leaseId": e.lease.ID,
		"req":     req,
	}, &res)
	return res, err
}

func (e *RemoteEnv) HarvestOutputs(ctx context.Context) ([]contract.HarvestedOutput, error) {
	var outs []contract.HarvestedOutput
	err := e.machine.Link.Call(ctx, "env.harvest", map[string]any{
		"leaseId": e.lease.ID,
	}, &outs)
	return outs, err
}

func (e *RemoteEnv) Close() error {
	var closeErr error
	e.closeOnce.Do(func() {
		closeErr = e.hub.Release(context.Background(), e.lease)
	})
	return closeErr
}
