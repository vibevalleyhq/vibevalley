package memory

import (
	"context"

	"vibevalley/internal/protocol"
)

// One place memories live: this farm's database, or a memory service outside it (Nowledge Mem, EverOS). Modeled on Hermes's
// MemoryProvider (agent/memory_provider.py); its names are in the comments. Only what something calls is here: a hook comes with
// its first caller (.agents/notes/proposed/architecture/2026-10-18-memory-providers.md lists the rest).
type provider interface {
	// name. Prefixes the ids of the memories it gives, except the local one's: theirs were there before any other.
	Name() string
	// is_available + unavailable_reason: configured and ready, by config alone; no network here.
	Available() (bool, string)
	// initialize, shutdown.
	OnStart(ctx context.Context) error
	OnStop()

	// prefetch: what the agent should recall as a run starts, best first. The caller bounds how long it may take; cue.Peek asks
	// without counting anything as recalled.
	Prefetch(ctx context.Context, cue RecallCue) ([]recalledLine, error)
	// sync_turn: one finished run, everything about it; each provider keeps what it uses.
	SyncTurn(ctx context.Context, run FinishedRun) error
	// on_session_end: the session has left the farm; EverOS extracts what it was given (flush) here.
	OnSessionEnd(ctx context.Context, s EndedSession) error
	// Behind memory_search: at most q.Limit, best first; Score orders only this provider's own.
	Search(ctx context.Context, q SearchQuery) ([]Found, error)

	// What the owner sees and does on an agent's 记性 tab; Hermes has no listing.
	List(ctx context.Context, agent string) ([]protocol.Memory, error)
	Add(ctx context.Context, n Note) (protocol.Memory, error)
	Forget(ctx context.Context, agent, id string) error
	// What the 记性 tab may offer for it.
	Can() abilities
}

type abilities struct {
	List   bool
	Forget bool
	// It wants whole runs (EverOS), not only the 「记住：」 lines.
	Transcripts bool
}

// One line a provider would have the agent recall, with how good a match it is (only to order lines from several providers).
type recalledLine struct {
	ID    string
	Line  string
	Score float64
}

// A memory written outside a run: the owner's, from the 记性 tab.
type Note struct {
	Agent   string
	Text    string
	Project string
}
