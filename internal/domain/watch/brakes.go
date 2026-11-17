package watch

import (
	"slices"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// BrakeInput supplies the event, channel metadata, active seats, and brake counters
// to EvaluateBrakes.
type BrakeInput struct {
	Event          channel.Event
	Channel        channel.Channel
	ChannelMembers []string
	Seats          []Seat
	NowMs          int64
	Config         BrakeConfig
	State          BrakeState
}

// BrakeEvaluation returns the per-recipient decisions and the next BrakeState snapshot
// (applied only once dispatches commit).
type BrakeEvaluation struct {
	Decisions []WakeDecision
	NextState BrakeState
}

type brakeCandidate struct {
	agentID string
	seat    Seat
	allowed bool
	brake   BrakeKind
	reason  string
}

// EvaluateBrakes applies the three wakeup brakes in order:
// 1) Explicit mention / thread-scope gate (BrakeMentionScope),
// 2) Max consecutive agent turns brake (BrakeHopLimit),
// 3) Cooldown rate brake (BrakeCooldown), plus wake-breaker circuit protection.
func EvaluateBrakes(in BrakeInput) BrakeEvaluation {
	cfg := in.Config.withDefaults()
	next := cloneBrakeState(in.State)
	ev := in.Event
	reqID := RequestIDForEvent(ev.ChannelID, ev.Seq)
	scopeKey := ev.ChannelID

	if ev.Kind == contract.ChannelEventReaction || ev.ActorKind == channel.ActorSystem {
		return BrakeEvaluation{NextState: next}
	}

	// User speech resets consecutive agent turn hops in this scope.
	if ev.ActorKind == channel.ActorUser {
		delete(next.ConsecutiveAgentTurns, scopeKey)
	}

	seatByAgent := make(map[string]Seat, len(in.Seats))
	for _, s := range in.Seats {
		if s.Active {
			seatByAgent[s.AgentID] = s
		}
	}

	candidates := make([]brakeCandidate, 0, len(in.Seats))
	seen := make(map[string]bool)
	addCandidate := func(agentID string, seat Seat, allowed bool, brake BrakeKind, reason string) {
		if agentID == "" || agentID == ev.AuthorID || seen[agentID] {
			return
		}
		if containsFold(cfg.OwnerActorIDs, agentID) {
			return
		}
		seen[agentID] = true
		candidates = append(candidates, brakeCandidate{
			agentID: agentID,
			seat:    seat,
			allowed: allowed,
			brake:   brake,
			reason:  reason,
		})
	}

	// Separate explicit mentions into owner vs agent mentions and broadcast mentions.
	var explicitAgents []string
	hasBroadcastEveryone := false
	for _, m := range ev.Mentions {
		if m == "everyone" || m == "all" {
			hasBroadcastEveryone = true
			continue
		}
		if containsFold(cfg.OwnerActorIDs, m) {
			continue
		}
		if !slices.Contains(explicitAgents, m) {
			explicitAgents = append(explicitAgents, m)
		}
	}
	if ev.TargetAgentID != "" && !containsFold(cfg.OwnerActorIDs, ev.TargetAgentID) {
		if !slices.Contains(explicitAgents, ev.TargetAgentID) {
			explicitAgents = append(explicitAgents, ev.TargetAgentID)
		}
	}

	// Passive progress reports do not wake anyone unless explicitly mentioned or failed.
	if ev.Kind == contract.ChannelEventReport {
		isFailed := ev.Report != nil && ev.Report.Outcome == "failed"
		if !isFailed && len(explicitAgents) == 0 {
			for _, s := range in.Seats {
				if s.Active && s.AgentID != ev.AuthorID {
					addCandidate(s.AgentID, s, false, BrakeMentionScope, "passive progress report without explicit mention")
				}
			}
			return buildOutcome(candidates, next, reqID)
		}
		if isFailed && len(explicitAgents) == 0 {
			for _, mid := range in.ChannelMembers {
				if s, ok := seatByAgent[mid]; ok {
					addCandidate(mid, s, true, BrakeNone, "failed report alerts channel member")
				}
			}
			if in.Channel.DefaultAgentID != "" {
				if s, ok := seatByAgent[in.Channel.DefaultAgentID]; ok {
					addCandidate(in.Channel.DefaultAgentID, s, true, BrakeNone, "failed report alerts default agent")
				}
			}
		}
	}

	// Gate 1 (BrakeMentionScope): Channel/Thread scope & explicit mention rules.
	switch in.Channel.Type {
	case channel.TypeDirect:
		peer := in.Channel.PeerID
		if peer == "" {
			for _, s := range in.Seats {
				if s.Active && s.AgentID != ev.AuthorID {
					peer = s.AgentID
					break
				}
			}
		}
		for _, target := range explicitAgents {
			if target != peer {
				addCandidate(target, seatByAgent[target], false, BrakeMentionScope, "target outside direct channel scope")
			}
		}
		if ev.ActorKind == channel.ActorUser && peer != "" {
			if s, ok := seatByAgent[peer]; ok {
				addCandidate(peer, s, true, BrakeNone, "direct message to peer")
			}
		}

	case channel.TypeThread:
		for _, target := range explicitAgents {
			s, ok := seatByAgent[target]
			if !ok {
				addCandidate(target, Seat{}, false, BrakeMentionScope, "target outside thread scope")
				continue
			}
			addCandidate(target, s, true, BrakeNone, "explicit mention within thread scope")
		}
		if len(explicitAgents) == 0 {
			// In a bounded thread, unmentioned messages wake seated thread owners, workers, and thread members.
			for _, s := range in.Seats {
				if !s.Active || s.AgentID == ev.AuthorID {
					continue
				}
				if s.ThreadOwner || s.Role == channel.RoleWorker || slices.Contains(in.ChannelMembers, s.AgentID) {
					addCandidate(s.AgentID, s, true, BrakeNone, "thread-scoped participant")
				}
			}
		}

	default: // Public channel (channel.TypePublic)
		if hasBroadcastEveryone {
			for _, s := range in.Seats {
				if !s.Active || s.AgentID == ev.AuthorID {
					continue
				}
				if ev.ActorKind == channel.ActorUser {
					addCandidate(s.AgentID, s, true, BrakeNone, "user broadcast @everyone")
				} else {
					addCandidate(s.AgentID, s, false, BrakeMentionScope, "agent @everyone gated in public channel")
				}
			}
		}
		for _, target := range explicitAgents {
			s, ok := seatByAgent[target]
			if !ok {
				addCandidate(target, Seat{}, false, BrakeMentionScope, "mentioned agent not seated in channel")
				continue
			}
			addCandidate(target, s, true, BrakeNone, "explicitly mentioned in channel")
		}
		if len(explicitAgents) == 0 && !hasBroadcastEveryone {
			if ev.ActorKind == channel.ActorAgent {
				// Agents posting in a public channel without an explicit mention are gated!
				for _, s := range in.Seats {
					if s.Active && s.AgentID != ev.AuthorID {
						addCandidate(s.AgentID, s, false, BrakeMentionScope, "public channel agent post requires explicit @mention")
					}
				}
			} else if ev.ActorKind == channel.ActorUser {
				// User public post without @mention wakes only designated channel members / default agent.
				designated := make(map[string]bool)
				for _, m := range in.ChannelMembers {
					designated[m] = true
				}
				if in.Channel.DefaultAgentID != "" {
					designated[in.Channel.DefaultAgentID] = true
				}
				for _, s := range in.Seats {
					if !s.Active || s.AgentID == ev.AuthorID {
						continue
					}
					if designated[s.AgentID] {
						addCandidate(s.AgentID, s, true, BrakeNone, "channel member addressed by user")
					} else {
						addCandidate(s.AgentID, s, false, BrakeMentionScope, "unmentioned public worker gated")
					}
				}
			}
		}
	}

	// Gate 2 & Gate 3: Apply Hop Limit (MaxConsecutiveAgentTurns) and Cooldown Rate Brake
	// to any candidate that passed BrakeMentionScope.
	hops := next.ConsecutiveAgentTurns[scopeKey]
	byAgent := ev.ActorKind == channel.ActorAgent

	for i := range candidates {
		c := &candidates[i]
		if !c.allowed {
			continue
		}

		// User speaking directly or mentioning resets empty-wake circuit breaker for that recipient.
		if ev.ActorKind == channel.ActorUser {
			delete(next.EmptyWakes, c.agentID)
			delete(next.BrokenAgents, c.agentID)
			continue
		}

		// Brake 1: Max consecutive agent turns (hop limit).
		if byAgent && hops >= cfg.MaxConsecutiveAgentTurns {
			c.allowed = false
			c.brake = BrakeHopLimit
			c.reason = "max consecutive agent turns brake reached"
			continue
		}

		// Brake 2: Cooldown rate brake.
		if byAgent && !(c.seat.Role == channel.RoleOrchestrator && cfg.OrchestratorExemptFromCooldown) {
			if lastWake, ok := next.LastAgentWakeAtMs[c.agentID]; ok && in.NowMs-lastWake < cfg.CooldownWindow.Milliseconds() {
				c.allowed = false
				c.brake = BrakeCooldown
				c.reason = "cooldown rate brake active for recipient"
				continue
			}
		}

		// Circuit breaker for consecutive empty wakes.
		if next.BrokenAgents[c.agentID] {
			c.allowed = false
			c.brake = BrakeWakeBreaker
			c.reason = "wake breaker tripped after repeated empty wakes"
			continue
		}

		if byAgent {
			hops++
			next.ConsecutiveAgentTurns[scopeKey] = hops
			next.LastAgentWakeAtMs[c.agentID] = in.NowMs
		}
	}

	return buildOutcome(candidates, next, reqID)
}

func buildOutcome(candidates []brakeCandidate, next BrakeState, reqID string) BrakeEvaluation {
	decisions := make([]WakeDecision, len(candidates))
	for i, c := range candidates {
		decisions[i] = WakeDecision{
			RecipientID:    c.agentID,
			ConversationID: c.seat.ConversationID,
			SessionID:      c.seat.SessionID,
			Allowed:        c.allowed,
			Brake:          c.brake,
			Reason:         c.reason,
			RequestID:      reqID,
		}
	}
	return BrakeEvaluation{
		Decisions: decisions,
		NextState: next,
	}
}
