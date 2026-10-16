// Package agents is subagents (packages/oar/src/agents): child sessions a
// host starts on any runtime, follows by reports (one per turn their root
// agent ends) and task events, and can feed back into a parent session. The
// mechanism is here; limits, permissions and whether reports wake a parent
// are the host's choices. See docs/spec/subagents.md.
package agents

import (
	"time"

	"vibevalley/pkg/smith/oar"
)

// Options configures New.
type Options struct {
	// Where Spawn finds runtimes by id. Required: TS defaults to the built-in
	// registry, which Go does not have yet (runtimes/defaults); with nil every
	// spawn is refused unknown_runtime.
	Runtimes *oar.RuntimeRegistry
	// Subagents whose turn may run at once; a spawn or follow-up past it is refused. 0: 4.
	MaxRunning int
	// How deep subagents may nest. This process's own depth is
	// OAR_SUBAGENT_DEPTH (0 when unset); its children run with depth + 1, so a
	// child that hosts subagents of its own refuses once the limit is
	// reached. 0: 1 (children do not spawn).
	MaxDepth int
	// Working directory for children that name none; the process's cwd when "".
	Cwd string
	// Write each child's records to <LogDir>/<name or runtime>-<sessionId>.jsonl as an oar-voyage log.
	LogDir string
	// Environment overlaid on every child (each spawn may add its own); nil values remove.
	Env map[string]*string
}

// SpawnOptions is one child to start.
type SpawnOptions struct {
	Runtime string
	// The first input: the task.
	Task string
	// A name the parent can use for it; the id is Name when free, else derived. "" is no name.
	Name        string
	Cwd         string
	Model       string
	Effort      string
	ServiceTier string
	// Resume this runtime-native session (a previous report's SessionID) instead of starting one.
	Resume string
	Env    map[string]*string
}

// SpawnRefusalCode: "unknown_runtime" | "not_installed" | "depth_limit" |
// "running_limit" | "open_failed" | "rejected" | "closed".
type SpawnRefusalCode = string

// SpawnResult is "spawned" (Agent) or "refused" (Code, Reason).
type SpawnResult struct {
	Kind   string
	Agent  *Subagent
	Code   SpawnRefusalCode
	Reason string
}

// SubagentState is "running" while a turn of the child's root agent is
// open, "idle", or "closed" after Close.
type SubagentState = string

// SubagentReport is one finished turn of a subagent: what its parent reads.
type SubagentReport struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	Runtime string `json:"runtime"`
	// The runtime-native session: pass it as SpawnOptions.Resume to continue later.
	SessionID string `json:"sessionId"`
	// 1 for the task, then one per later turn (a follow-up, a queued input, a turn the runtime began itself).
	Turn    int             `json:"turn"`
	Outcome oar.TurnOutcome `json:"outcome"`
	// What the child's root agent said in that turn, as the runtime said it.
	Text    string `json:"text"`
	Log     string `json:"log,omitempty"`
	EndedAt int64  `json:"endedAt"`
}

// SubagentInfo is a subagent's identity and state.
type SubagentInfo struct {
	ID        string        `json:"id"`
	Name      string        `json:"name,omitempty"`
	Runtime   string        `json:"runtime"`
	SessionID string        `json:"sessionId"`
	State     SubagentState `json:"state"`
	// Turns ended so far.
	Turns int    `json:"turns"`
	Log   string `json:"log,omitempty"`
}

// SendMode is how a message reaches a child: "followup" (default when "")
// starts a turn when the child is idle and steers the running one otherwise
// (queueing when it cannot steer); "steer" and "queue" are the session
// controls of the same names, and "steer" is rejected unsupported when the
// child's session cannot steer.
type SendMode = string

// SendResult is "accepted" (Landed "prompted" | "steered" | "queued") or "rejected" (Code, Reason).
type SendResult struct {
	Kind   string `json:"kind"`
	Landed string `json:"landed,omitempty"`
	Code   string `json:"code,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// SubagentTaskEvent is a task event about a subagent, in the shape runtimes
// report their own tasks (TaskStarted, TaskUpdated or TaskEnded); At is when it happened.
type SubagentTaskEvent struct {
	Body oar.EventBody
	At   int64
}

// WaitOptions for Subagents.Wait.
type WaitOptions struct {
	// Only these subagents' reports; all when nil.
	IDs []string
	// How long to wait when no report is unread. 0: 30 s; negative: return at
	// once (TS timeoutMs: 0). Cancelling the context stops waiting, taking nothing.
	Timeout time.Duration
}

// ReportHandler takes a report; an error (or a panic) means it did not.
type ReportHandler func(SubagentReport) error
