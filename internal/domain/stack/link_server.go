package stack

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// HandleClientWebSocket upgrades an HTTP request on /chord/ws into a multiplexed Chord Link
// serving SpaceView incremental watches and domain RPCs.
func (s *Stack) HandleClientWebSocket(w http.ResponseWriter, r *http.Request) {
	tr, err := link.UpgradeWebSocket(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.AttachClientLink(r.Context(), tr); err != nil {
		_ = tr.Close()
		return
	}
}

// AttachClientLink binds a FrameTransport (WebSocket or in-process desktop pipe) to a live Chord Link,
// publishes the reactive SpaceView ("space"), registers domain RPCs, and executes the Principal handshake.
func (s *Stack) AttachClientLink(ctx context.Context, transport link.FrameTransport, customOpts ...link.Options) (*link.Link, error) {
	if s.closed.Load() {
		return nil, ErrClosed
	}
	if ctx == nil {
		ctx = s.bgCtx
	}

	opts := link.Options{
		Principal: link.Principal{
			Kind: link.PrincipalUserDevice,
			ID:   "vibe-server",
		},
		SidePrefix: "srv",
	}
	if len(customOpts) > 0 {
		if customOpts[0].Principal.Kind != "" && customOpts[0].Principal.ID != "" {
			opts.Principal = customOpts[0].Principal
		}
		if customOpts[0].Authenticate != nil {
			opts.Authenticate = customOpts[0].Authenticate
		}
		if customOpts[0].HeartbeatInterval > 0 {
			opts.HeartbeatInterval = customOpts[0].HeartbeatInterval
		}
		if customOpts[0].HeartbeatTimeout > 0 {
			opts.HeartbeatTimeout = customOpts[0].HeartbeatTimeout
		}
	}
	if opts.Authenticate == nil && s.cfg.LinkAuthenticator != nil {
		opts.Authenticate = s.cfg.LinkAuthenticator
	}

	var lnk *link.Link
	var untrackOnce sync.Once
	opts.OnClose = func(_ error) {
		untrackOnce.Do(func() {
			if lnk != nil {
				s.removeClientLink(lnk)
			}
		})
	}

	lnk = link.NewLink(transport, opts)
	s.registerClientHandlers(lnk)
	if err := lnk.Start(ctx); err != nil {
		return nil, err
	}

	s.addClientLink(lnk)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		lnk.Wait()
		untrackOnce.Do(func() {
			s.removeClientLink(lnk)
		})
	}()

	return lnk, nil
}

func (s *Stack) addClientLink(lnk *link.Link) {
	s.clientLinksMu.Lock()
	s.clientLinks[lnk] = struct{}{}
	s.clientLinksMu.Unlock()
}

func (s *Stack) removeClientLink(lnk *link.Link) {
	s.clientLinksMu.Lock()
	delete(s.clientLinks, lnk)
	s.clientLinksMu.Unlock()
}

func (s *Stack) closeAllClientLinks() {
	s.clientLinksMu.Lock()
	links := make([]*link.Link, 0, len(s.clientLinks))
	for lnk := range s.clientLinks {
		links = append(links, lnk)
	}
	s.clientLinksMu.Unlock()
	for _, lnk := range links {
		_ = lnk.Close()
	}
}

func (s *Stack) registerClientHandlers(lnk *link.Link) {
	if s.Game != nil && s.Game.Document() != nil {
		lnk.PublishDocument("space", s.Game.Document())
	}

	lnk.HandleRPC("health.ping", func(_ context.Context, _ json.RawMessage) (any, error) {
		return map[string]any{
			"ok":             true,
			"serverUrl":      s.ServerURL(),
			"onlineMachines": s.Machines.OnlineIDs(),
		}, nil
	})

	lnk.HandleRPC("space.snapshot", func(_ context.Context, _ json.RawMessage) (any, error) {
		if s.Game == nil {
			return contract.SpaceView{}, nil
		}
		rev, view := s.Game.Snapshot()
		return map[string]any{
			"rev":  rev,
			"view": view,
		}, nil
	})

	lnk.HandleRPC("issue.create", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			Issue    issue.Issue `json:"issue"`
			Dispatch bool        `json:"dispatch,omitempty"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if p.Dispatch {
			iss, receipt, err := s.CreateAndDispatchIssue(ctx, p.Issue)
			if err != nil {
				return nil, err
			}
			return map[string]any{"issue": iss, "receipt": receipt}, nil
		}
		iss, err := s.Issues.CreateIssue(ctx, p.Issue)
		if err != nil {
			return nil, err
		}
		_ = s.SyncSpaceProjection(ctx)
		return map[string]any{"issue": iss}, nil
	})

	lnk.HandleRPC("issue.list", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			Statuses []contract.IssueStatus `json:"statuses,omitempty"`
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &p)
		}
		return s.Issues.ListIssueViews(ctx, p.Statuses...)
	})

	lnk.HandleRPC("issue.queue", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			IssueID string `json:"issueId"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		iss, receipt, err := s.QueueAndDispatchIssue(ctx, p.IssueID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"issue": iss, "receipt": receipt}, nil
	})

	lnk.HandleRPC("channel.post", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req channel.AppendRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		res, outcomes, err := s.PostAndPumpChannel(ctx, req)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"event":    res.Event,
			"outcomes": outcomes,
		}, nil
	})

	lnk.HandleRPC("channel.events", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChannelID string `json:"channelId"`
			AfterSeq  int64  `json:"afterSeq"`
			Limit     int    `json:"limit"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return s.Channels.ListEventViews(ctx, p.ChannelID, p.AfterSeq, p.Limit)
	})

	lnk.HandleRPC("approval.resolve", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ConversationID string `json:"conversationId"`
			TaskID         string `json:"taskId"`
			ToolCallID     string `json:"toolCallId"`
			Approved       bool   `json:"approved"`
			Reason         string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if err := s.ResolveApproval(ctx, p.ConversationID, p.TaskID, p.ToolCallID, p.Approved, p.Reason); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	lnk.HandleRPC("budget.raise", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ConversationID   string `json:"conversationId"`
			TaskID           string `json:"taskId"`
			NewMaxCostMicros int64  `json:"newMaxCostMicros"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return s.RaiseBudget(ctx, p.ConversationID, p.TaskID, p.NewMaxCostMicros)
	})

	lnk.HandleRPC("pkm.search", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var q pkm.SearchQuery
		if err := json.Unmarshal(raw, &q); err != nil {
			return nil, err
		}
		return s.PKM.Search(ctx, q)
	})

	lnk.HandleRPC("pkm.backlinks", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			Target string `json:"target"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return s.PKM.Backlinks(ctx, p.Target)
	})

	lnk.HandleRPC("memory.dream.run", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ScopeID          string                  `json:"scopeId"`
			SessionSummaries []memory.SessionSummary `json:"sessionSummaries"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return s.RunDreamCycle(ctx, p.ScopeID, p.SessionSummaries)
	})

	lnk.HandleRPC("memory.dream.approve", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ProposalID string `json:"proposalId"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return s.ApproveDream(ctx, p.ProposalID)
	})

	lnk.HandleRPC("memory.dream.rollback", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ProposalID string `json:"proposalId"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return s.RollbackDream(ctx, p.ProposalID)
	})

	lnk.HandleRPC("artifact.publish", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req artifact.PublishRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		return s.Artifacts.Deliverables.Publish(ctx, req)
	})

	lnk.HandleRPC("vault.token.issue", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			PrincipalID  string   `json:"principalId"`
			SessionID    string   `json:"sessionId"`
			Capabilities []string `json:"capabilities"`
			AllowedHosts []string `json:"allowedHosts"`
			SecretIDs    []string `json:"secretIds"`
			TTLSeconds   int64    `json:"ttlSeconds"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if p.PrincipalID == "" {
			p.PrincipalID = lnk.PeerPrincipal().ID
		}
		ttl := time.Duration(p.TTLSeconds) * time.Second
		if p.SessionID == "" {
			return nil, errors.New("stack: sessionId required")
		}
		return s.IssueEgressToken(ctx, p.PrincipalID, p.SessionID, p.AllowedHosts, p.SecretIDs, ttl, p.Capabilities...)
	})
}
