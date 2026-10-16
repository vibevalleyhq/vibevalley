package shared

import (
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// NewSessionLinks adds lineage to its first source frame, including at most
// one copy within that frame: the session_linked events for edges the
// kernel's graph does not have yet.
func NewSessionLinks(k *kernel.Kernel, edges []oar.SessionEdge) []oar.SessionLinked {
	known := k.Graph().Edges
	var added []oar.SessionLinked
	for _, edge := range edges {
		seen := false
		for _, candidate := range known {
			if candidate.Parent == edge.Parent && candidate.Child == edge.Child {
				seen = true
				break
			}
		}
		for _, candidate := range added {
			if candidate.Parent == edge.Parent && candidate.Child == edge.Child {
				seen = true
				break
			}
		}
		if !seen {
			added = append(added, k.Link(edge))
		}
	}
	return added
}
