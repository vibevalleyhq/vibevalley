package project

type Workplace struct {
	Project string `json:"project"`
	Cwd     string `json:"cwd"`
	// Branch is empty when it works in the project folder itself.
	Branch string `json:"branch,omitzero"`
}

type Project struct {
	Name string
	Path string
	Git  bool
}

type Merged struct {
	Text    string
	Commits int
	Hashes  []string
	// Publication succeeded; these resources could not be removed.
	Warning string
}

type MergeFailure struct {
	Kind   string // conflict, check, error
	Base   string
	Files  []string
	Reason string
}

func (h MergeFailure) Error() string {
	if h.Kind == "conflict" {
		return "合进 " + h.Base + " 有冲突"
	}
	return h.Reason
}
