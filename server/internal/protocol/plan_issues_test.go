package protocol

func withPlaybooks(state CoreState, playbooks ...Playbook) CoreState {
	for _, pb := range playbooks {
		for _, t := range PlaybookIssues(pb, nil, pb.CreatedAt) {
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
