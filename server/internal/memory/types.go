package memory

import (
	"vibevalley/internal/protocol"
)

type FinishedRun struct {
	Agent   string
	Session string
	Project string
	Job     string
	Outcome protocol.Outcome
	Said    string
	Summary string
}

type RecallCue struct {
	Agent   string
	Session string
	Project string
	Text    string
	Skip    map[string]bool
	// Only asking: nothing is counted as recalled (the 记性 tab's preview).
	Peek bool
}

// What memory_search asks.
type SearchQuery struct {
	// "": every profile (only the manager may ask so).
	Agent string
	// "": every project; else that project's memories and those for every project.
	Project string
	Text    string
	// "": any kind.
	Kind protocol.MemoryKind
	// 0: searchLimit.
	Limit int
}

// One memory a search found, with where it lives and how good a match it is within that source.
type Found struct {
	protocol.Memory
	Source string
	Score  float64
}

// What a run recalls: the memories' ids (not to give the same session again) and the lines it is told, as it is told them.
type Recalled struct {
	IDs   []string
	Lines []string
}

type EndedSession struct {
	Agent   string
	Session string
	Project string
}
