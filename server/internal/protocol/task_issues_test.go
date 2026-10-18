package protocol

func withGraphs(state CoreState, graphs ...TaskGraph) CoreState {
	for _, graph := range graphs {
		for _, t := range GraphIssues(graph, nil, graph.CreatedAt) {
			state, _ = Reduce(state, Fact{FactIssue{Issue: t}})
		}
	}
	return state
}

func issueIn(state CoreState, id string) Issue {
	for _, t := range state.Issues {
		if t.ID == id {
			return t
		}
	}
	return Issue{}
}
