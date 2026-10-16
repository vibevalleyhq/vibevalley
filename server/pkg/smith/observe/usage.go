package observe

import (
	"encoding/json"

	"vibevalley/pkg/smith/oar"
)

func inSession(record oar.RawEvent, sessionID string) bool {
	return sessionID == "" || record.SessionID == sessionID
}

// latestRoot folds the last event a pick function accepts from root-agent frames.
func latestRoot[T any](records []oar.RawEvent, sessionID string, pick func(oar.EventBody) (T, bool)) oar.QueryResult[*T] {
	var value *T
	seq := int64(-1)
	for _, record := range records {
		if !inSession(record, sessionID) {
			continue
		}
		seq = record.Seq
		if record.Kind != oar.KindFrame || len(record.AgentPath) > 0 {
			continue
		}
		for i := len(record.Frame.Events) - 1; i >= 0; i-- {
			if picked, ok := pick(record.Frame.Events[i]); ok {
				copied := picked
				value = &copied
				break
			}
		}
	}
	return oar.QueryResult[*T]{Value: value, Seq: seq}
}

// ModelOf is the latest model the runtime reported for the root agent; nil before any.
func ModelOf(records []oar.RawEvent, sessionID string) oar.QueryResult[*string] {
	return latestRoot(records, sessionID, func(event oar.EventBody) (string, bool) {
		e, ok := event.(oar.Model)
		return e.Model, ok
	})
}

// EffortOf is the latest reasoning-effort level the runtime reported; nil before any.
func EffortOf(records []oar.RawEvent, sessionID string) oar.QueryResult[*string] {
	return latestRoot(records, sessionID, func(event oar.EventBody) (string, bool) {
		e, ok := event.(oar.Effort)
		return e.Effort, ok
	})
}

// ServiceTierOf is the latest service tier the runtime reported; nil before any.
func ServiceTierOf(records []oar.RawEvent, sessionID string) oar.QueryResult[*string] {
	return latestRoot(records, sessionID, func(event oar.EventBody) (string, bool) {
		e, ok := event.(oar.ServiceTier)
		return e.ServiceTier, ok
	})
}

// ContextUsageOf is the latest context fullness for the root agent; nil before any.
func ContextUsageOf(records []oar.RawEvent, sessionID string) oar.QueryResult[*oar.ContextUsage] {
	result := latestRoot(records, sessionID, func(event oar.EventBody) (*oar.ContextUsage, bool) {
		e, ok := event.(oar.Usage)
		if !ok || e.Usage.Context == nil {
			return nil, false
		}
		return e.Usage.Context, true
	})
	if result.Value == nil {
		return oar.QueryResult[*oar.ContextUsage]{Seq: result.Seq}
	}
	return oar.QueryResult[*oar.ContextUsage]{Value: *result.Value, Seq: result.Seq}
}

// ─── Token arithmetic (shared/token-totals.ts) ─────────────────────────────

func sumPart(previous, report *int64) *int64 {
	if previous == nil && report == nil {
		return nil
	}
	var total int64
	if previous != nil {
		total += *previous
	}
	if report != nil {
		total += *report
	}
	return &total
}

// AddTokens is previous plus one report's counts. Optional parts exist only once a report carried them.
func AddTokens(previous, report oar.TokenTotals) oar.TokenTotals {
	return oar.TokenTotals{
		Input:      previous.Input + report.Input,
		Output:     previous.Output + report.Output,
		Reasoning:  sumPart(previous.Reasoning, report.Reasoning),
		CacheRead:  sumPart(previous.CacheRead, report.CacheRead),
		CacheWrite: sumPart(previous.CacheWrite, report.CacheWrite),
	}
}

func lessPart(total, baseline *int64) *int64 {
	if total == nil {
		return nil
	}
	value := *total
	if baseline != nil {
		value -= *baseline
	}
	return &value
}

// SubtractTokens is total counted from baseline on.
func SubtractTokens(total, baseline oar.TokenTotals) oar.TokenTotals {
	return oar.TokenTotals{
		Input:      total.Input - baseline.Input,
		Output:     total.Output - baseline.Output,
		Reasoning:  lessPart(total.Reasoning, baseline.Reasoning),
		CacheRead:  lessPart(total.CacheRead, baseline.CacheRead),
		CacheWrite: lessPart(total.CacheWrite, baseline.CacheWrite),
	}
}

// ─── Usage (observe/usage.ts, usage-totals.ts) ─────────────────────────────

// SessionTokens is what one session's records said about tokens.
type SessionTokens struct {
	order  []string
	agents map[string]oar.AgentTotal
	total  *oar.TokenTotals
}

func agentKey(path []string) string {
	if path == nil {
		path = []string{}
	}
	encoded, _ := json.Marshal(path)
	return string(encoded)
}

// FoldSessionTokens records one usage report, returning a new value.
func FoldSessionTokens(previous *SessionTokens, agentPath []string, usage oar.UsageReport) *SessionTokens {
	next := &SessionTokens{agents: map[string]oar.AgentTotal{}}
	if previous != nil {
		next.order = append(next.order, previous.order...)
		for key, value := range previous.agents {
			next.agents[key] = value
		}
		next.total = previous.total
	}
	if usage.Tokens != nil {
		key := agentKey(agentPath)
		if _, ok := next.agents[key]; !ok {
			next.order = append(next.order, key)
		}
		path := agentPath
		if path == nil {
			path = []string{}
		}
		next.agents[key] = oar.AgentTotal{AgentPath: path, Tokens: *usage.Tokens}
	}
	if usage.Total != nil {
		next.total = usage.Total
	}
	return next
}

func (s *SessionTokens) byAgent() []oar.AgentTotal {
	out := make([]oar.AgentTotal, 0, len(s.order))
	for _, key := range s.order {
		out = append(out, s.agents[key])
	}
	return out
}

func hasTokens(tokens oar.TokenTotals) bool { return tokens.Input > 0 || tokens.Output > 0 }

// SessionUsageFrom builds a session's usage from each agent's latest total and the runtime's own session total.
func SessionUsageFrom(byAgent []oar.AgentTotal, reported *oar.TokenTotals) oar.SessionUsage {
	if len(byAgent) == 0 && reported == nil {
		return oar.SessionUsage{}
	}
	attributed := oar.TokenTotals{}
	for _, entry := range byAgent {
		attributed = AddTokens(attributed, entry.Tokens)
	}
	var unattributed *oar.TokenTotals
	if reported != nil {
		remainder := SubtractTokens(*reported, attributed)
		if hasTokens(remainder) {
			unattributed = &remainder
		}
	}
	onlyRoot := len(byAgent) <= 1
	for _, entry := range byAgent {
		if len(entry.AgentPath) != 0 {
			onlyRoot = false
		}
	}
	usage := oar.SessionUsage{Unattributed: unattributed}
	if reported != nil {
		total := *reported
		usage.Total = &total
	} else {
		usage.Total = &attributed
	}
	if !onlyRoot || unattributed != nil {
		usage.ByAgent = byAgent
	}
	return usage
}

// DerivedFrom is every session derived from sessionID in the graph, nested ones too, in discovery order.
func DerivedFrom(graph oar.SessionGraph, sessionID string) []string {
	var found []string
	seen := map[string]bool{}
	queue := []string{sessionID}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, edge := range graph.Edges {
			if edge.Parent == parent && edge.Child != sessionID && !seen[edge.Child] {
				seen[edge.Child] = true
				found = append(found, edge.Child)
				queue = append(queue, edge.Child)
			}
		}
	}
	return found
}

// UsageFromSessions is own usage plus each reachable child's latest total.
func UsageFromSessions(sessions map[string]*SessionTokens, sessionID string, graph oar.SessionGraph) oar.SessionUsage {
	ofSession := func(id string) oar.SessionUsage {
		session := sessions[id]
		if session == nil {
			return oar.SessionUsage{}
		}
		return SessionUsageFrom(session.byAgent(), session.total)
	}
	own := ofSession(sessionID)
	if own.Total == nil {
		return own
	}
	var children []oar.TokenTotals
	for _, child := range DerivedFrom(graph, sessionID) {
		if total := ofSession(child).Total; total != nil {
			children = append(children, *total)
		}
	}
	if len(children) == 0 {
		return own
	}
	sum := *own.Total
	for _, tokens := range children {
		sum = AddTokens(sum, tokens)
	}
	own.WithChildren = &sum
	return own
}

// UsageOf is the session total plus a per-agent breakdown. graph nil means GraphOf(records).
func UsageOf(records []oar.RawEvent, sessionID string, graph *oar.SessionGraph) oar.QueryResult[oar.SessionUsage] {
	lineage := oar.SessionGraph{}
	if graph != nil {
		lineage = *graph
	} else {
		lineage = GraphOf(records)
	}
	children := map[string]bool{}
	if sessionID != "" {
		for _, child := range DerivedFrom(lineage, sessionID) {
			children[child] = true
		}
	}
	sessions := map[string]*SessionTokens{}
	seq := int64(-1)
	for _, record := range records {
		related := inSession(record, sessionID) || children[record.SessionID]
		linked := false
		if record.Kind == oar.KindFrame {
			for _, event := range record.Frame.Events {
				if link, ok := event.(oar.SessionLinked); ok && children[link.Child] && (link.Parent == sessionID || children[link.Parent]) {
					linked = true
				}
			}
		}
		if related || linked {
			seq = record.Seq
		}
		if !related || record.Kind != oar.KindFrame {
			continue
		}
		key := ""
		if sessionID != "" {
			key = record.SessionID
		}
		for _, event := range record.Frame.Events {
			if usage, ok := event.(oar.Usage); ok {
				sessions[key] = FoldSessionTokens(sessions[key], record.AgentPath, usage.Usage)
			}
		}
	}
	scope := lineage
	if sessionID == "" {
		scope = oar.SessionGraph{}
	}
	return oar.QueryResult[oar.SessionUsage]{Value: UsageFromSessions(sessions, sessionID, scope), Seq: seq}
}

// ─── Graph (observe/graph.ts) ──────────────────────────────────────────────

// GraphBuilder keeps a session graph with an index of its nodes.
type GraphBuilder struct {
	graph oar.SessionGraph
	nodes map[string]bool
	edges map[[2]string]bool
}

// NewGraphBuilder starts a graph, optionally with a root node.
func NewGraphBuilder(root string) *GraphBuilder {
	builder := &GraphBuilder{graph: oar.SessionGraph{Nodes: []oar.SessionNode{}, Edges: []oar.SessionEdge{}}, nodes: map[string]bool{}, edges: map[[2]string]bool{}}
	if root != "" {
		builder.Node(root)
	}
	return builder
}

// Node adds a session node once.
func (b *GraphBuilder) Node(id string) {
	if b.nodes[id] {
		return
	}
	b.nodes[id] = true
	b.graph.Nodes = append(b.graph.Nodes, oar.SessionNode{ID: id})
}

// Link adds an edge once, with its nodes.
func (b *GraphBuilder) Link(edge oar.SessionEdge) {
	b.Node(edge.Parent)
	b.Node(edge.Child)
	key := [2]string{edge.Parent, edge.Child}
	if b.edges[key] {
		return
	}
	b.edges[key] = true
	b.graph.Edges = append(b.graph.Edges, edge)
}

// Record folds one record's graph facts.
func (b *GraphBuilder) Record(record oar.RawEvent) {
	b.Node(record.SessionID)
	if record.Kind != oar.KindFrame {
		return
	}
	for _, event := range record.Frame.Events {
		if link, ok := event.(oar.SessionLinked); ok {
			b.Link(oar.SessionEdge{Parent: link.Parent, Child: link.Child, Via: link.Via})
		}
	}
}

// Graph is a snapshot of the graph.
func (b *GraphBuilder) Graph() oar.SessionGraph {
	return oar.SessionGraph{Nodes: append([]oar.SessionNode{}, b.graph.Nodes...), Edges: append([]oar.SessionEdge{}, b.graph.Edges...)}
}

// GraphOf is the true sessions observed in records, with only runtime-reported lineage.
func GraphOf(records []oar.RawEvent) oar.SessionGraph {
	builder := NewGraphBuilder("")
	for _, record := range records {
		builder.Record(record)
	}
	return builder.Graph()
}
