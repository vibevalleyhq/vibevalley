package protocol

// withPlaybooks is state with the playbooks in it, as their issues.
func withPlaybooks(state FarmState, playbooks ...Playbook) FarmState {
	for _, pb := range playbooks {
		for _, t := range PlaybookIssues(pb, nil, pb.CreatedAt) {
			state, _ = Reduce(state, Fact{FactIssue{Issue: t}})
		}
	}
	return state
}

func issueIn(state FarmState, id string) Issue {
	for _, t := range state.Issues {
		if t.ID == id {
			return t
		}
	}
	return Issue{}
}
