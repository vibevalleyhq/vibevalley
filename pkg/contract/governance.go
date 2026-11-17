package contract

// BudgetSpec configures hard session spend limits in USD micros (1e-6 USD).
type BudgetSpec struct {
	MaxCostMicros int64 `json:"maxCostMicros"`
}

// BudgetSnapshot reports cumulative session + child task spend against the active budget gate.
type BudgetSnapshot struct {
	SpentMicros   int64 `json:"spentMicros"`
	MaxCostMicros int64 `json:"maxCostMicros"`
	Reached       bool  `json:"reached"`
}

// PermissionPolicy governs how tool invocations are authorized before execution.
type PermissionPolicy string

const (
	PolicyAlwaysAllow PermissionPolicy = "always_allow"
	PolicyAlwaysAsk   PermissionPolicy = "always_ask"
	PolicyAuto        PermissionPolicy = "auto"
)

// PermissionVerdict is the authorization decision for a single tool invocation.
type PermissionVerdict string

const (
	VerdictAllow PermissionVerdict = "allow"
	VerdictAsk   PermissionVerdict = "ask"
	VerdictDeny  PermissionVerdict = "deny"
)

// PermissionEvaluation records the evaluated verdict and whether user confirmation may override it.
type PermissionEvaluation struct {
	ToolName          string            `json:"toolName"`
	Policy            PermissionPolicy  `json:"policy"`
	Verdict           PermissionVerdict `json:"verdict"`
	Reason            string            `json:"reason,omitempty"`
	ClientOverridable bool              `json:"clientOverridable"`
}

// RubricSpec configures independent outcome grading when an agent yields completion.
type RubricSpec struct {
	Markdown      string `json:"markdown"`
	MaxIterations int    `json:"maxIterations"`
}

// RubricVerdict is returned by an isolated grader context before allowing session completion.
type RubricVerdict struct {
	Satisfied  bool     `json:"satisfied"`
	Summary    string   `json:"summary"`
	UnmetItems []string `json:"unmetItems,omitempty"`
	Iteration  int      `json:"iteration"`
}
