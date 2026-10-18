package protocol

import "regexp"

// The graph both a task's steps and an agent's own tasks are: nodes that wait for other nodes. What a node is, and
// what settles it, is the caller's; these say only what the edges allow.

type DagNode struct {
	ID    string
	After []string
}

// Ids are ASCII only: no case folding, so 'ſ' or the Kelvin sign is no 's' or 'k' here, as in JavaScript.
var dagID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$`)

func DagIDValid(id string) bool { return dagID.MatchString(id) }

type DagProblemKind string

const (
	DagDuplicate DagProblemKind = "duplicate"
	DagSelf      DagProblemKind = "self"
	DagMissing   DagProblemKind = "missing"
	DagCircle    DagProblemKind = "circle"
)

// ID is the node at fault; Other is the id it names (a missing one); Circle lists the nodes waiting on one another.
type DagProblem struct {
	Kind   DagProblemKind
	ID     string
	Other  string
	Circle []string
}

// In the nodes' order: duplicates, then each node's edges in order; a circle only when the edges are otherwise sound.
func DagProblems(nodes []DagNode) []DagProblem {
	var problems []DagProblem
	ids := map[string]bool{}
	for _, n := range nodes {
		if ids[n.ID] {
			problems = append(problems, DagProblem{Kind: DagDuplicate, ID: n.ID})
		}
		ids[n.ID] = true
	}
	for _, n := range nodes {
		for _, x := range n.After {
			if x == n.ID {
				problems = append(problems, DagProblem{Kind: DagSelf, ID: n.ID})
			} else if !ids[x] {
				problems = append(problems, DagProblem{Kind: DagMissing, ID: n.ID, Other: x})
			}
		}
	}
	if len(problems) > 0 {
		return problems
	}
	laid := map[string]bool{}
	for _, layer := range DagLayers(nodes) {
		for _, id := range layer {
			laid[id] = true
		}
	}
	var circle []string
	for _, n := range nodes {
		if !laid[n.ID] {
			circle = append(circle, n.ID)
		}
	}
	if len(circle) > 0 {
		problems = append(problems, DagProblem{Kind: DagCircle, Circle: circle})
	}
	return problems
}

// Longest path from a node that waits for nothing. A node caught in a circle is in no layer; an edge to an unknown
// node or to itself is ignored.
func DagLayers(nodes []DagNode) [][]string {
	known := map[string]bool{}
	for _, n := range nodes {
		known[n.ID] = true
	}
	depth := map[string]int{}
	// At most one pass per node.
	changed := true
	for pass := 0; changed && pass <= len(nodes); pass++ {
		changed = false
		for _, n := range nodes {
			if _, ok := depth[n.ID]; ok {
				continue
			}
			d, ready := 0, true
			for _, x := range n.After {
				if !known[x] || x == n.ID {
					continue
				}
				nd, ok := depth[x]
				if !ok {
					ready = false
					break
				}
				d = max(d, nd+1)
			}
			if !ready {
				continue
			}
			depth[n.ID] = d
			changed = true
		}
	}
	var layers [][]string
	for _, n := range nodes {
		d, ok := depth[n.ID]
		if !ok {
			continue
		}
		for len(layers) <= d {
			layers = append(layers, nil)
		}
		layers[d] = append(layers[d], n.ID)
	}
	out := [][]string{}
	for _, l := range layers {
		if l != nil {
			out = append(out, l)
		}
	}
	return out
}
