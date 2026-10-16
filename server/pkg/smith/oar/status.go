package oar

import "encoding/json"

func (c SessionCapabilities) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Queue struct {
			Durable bool `json:"durable"`
		} `json:"queue"`
		Attribution AttributionTier `json:"attribution"`
		Images      bool            `json:"images"`
	}{Queue: struct {
		Durable bool `json:"durable"`
	}{c.QueueDurable}, Attribution: c.Attribution, Images: c.Images})
}

func (c *SessionCapabilities) UnmarshalJSON(data []byte) error {
	var wire struct {
		Queue struct {
			Durable bool `json:"durable"`
		} `json:"queue"`
		Attribution AttributionTier `json:"attribution"`
		Images      bool            `json:"images"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*c = SessionCapabilities{QueueDurable: wire.Queue.Durable, Attribution: wire.Attribution, Images: wire.Images}
	return nil
}

// RunningPhase is "waiting_model", "thinking", "responding", "compacting",
// or a tool phase (Tool and CallID set; Writing while its arguments stream).
type RunningPhase struct {
	Name    string
	Tool    string
	CallID  string
	Writing bool
}

// Phase constants.
var (
	PhaseWaitingModel = RunningPhase{Name: "waiting_model"}
	PhaseThinking     = RunningPhase{Name: "thinking"}
	PhaseResponding   = RunningPhase{Name: "responding"}
	PhaseCompacting   = RunningPhase{Name: "compacting"}
)

// ToolPhase is the phase of a running tool call.
func ToolPhase(tool, callID string) RunningPhase { return RunningPhase{Tool: tool, CallID: callID} }

// IsTool reports a tool phase.
func (p RunningPhase) IsTool() bool { return p.Name == "" }

func (p RunningPhase) MarshalJSON() ([]byte, error) {
	if !p.IsTool() {
		return json.Marshal(p.Name)
	}
	o := newObject()
	if err := o.field("tool", p.Tool); err != nil {
		return nil, err
	}
	if err := o.field("callId", p.CallID); err != nil {
		return nil, err
	}
	if p.Writing {
		if err := o.field("writing", true); err != nil {
			return nil, err
		}
	}
	return o.bytes(), nil
}

func (p *RunningPhase) UnmarshalJSON(data []byte) error {
	var name string
	if err := json.Unmarshal(data, &name); err == nil {
		*p = RunningPhase{Name: name}
		return nil
	}
	var tool struct {
		Tool    string `json:"tool"`
		CallID  string `json:"callId"`
		Writing bool   `json:"writing"`
	}
	if err := json.Unmarshal(data, &tool); err != nil {
		return err
	}
	*p = RunningPhase{Tool: tool.Tool, CallID: tool.CallID, Writing: tool.Writing}
	return nil
}

// TurnStop is stop evidence retained for a running turn.
type TurnStop struct {
	PendingAbortIDs []string `json:"pendingAbortIds"`
	AbortedOnExit   bool     `json:"abortedOnExit"`
}

// PendingPrompt is native queue evidence retained across an unrelated spontaneous turn.
type PendingPrompt struct {
	InputID   string    `json:"inputId"`
	SinceSeq  int64     `json:"sinceSeq"`
	RequestID string    `json:"requestId,omitempty"`
	Stop      *TurnStop `json:"stop,omitempty"`
}

// AgentStatus is the root agent's status, a fold over the stream.
// Kind "idle" (LastTurnOutcome when a turn ended) or "running" (SinceSeq,
// RequestID, InputID, Stop, Phase, LastEventAt).
type AgentStatus struct {
	Kind            string
	LastTurnOutcome *TurnOutcome
	SinceSeq        int64
	RequestID       string
	InputID         string
	Stop            *TurnStop
	Phase           RunningPhase
	LastEventAt     int64
	PendingPrompt   *PendingPrompt
}

// IsRunning reports a running status.
func (s AgentStatus) IsRunning() bool { return s.Kind == "running" }

func (s AgentStatus) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("kind", s.Kind); err != nil {
		return nil, err
	}
	if s.Kind == "idle" {
		if s.LastTurnOutcome != nil {
			if err := o.field("lastTurnOutcome", s.LastTurnOutcome); err != nil {
				return nil, err
			}
		}
	} else {
		if err := o.field("sinceSeq", s.SinceSeq); err != nil {
			return nil, err
		}
		if s.RequestID != "" {
			if err := o.field("requestId", s.RequestID); err != nil {
				return nil, err
			}
		}
		if s.InputID != "" {
			if err := o.field("inputId", s.InputID); err != nil {
				return nil, err
			}
		}
		if s.Stop != nil {
			if err := o.field("stop", s.Stop); err != nil {
				return nil, err
			}
		}
		if err := o.field("phase", s.Phase); err != nil {
			return nil, err
		}
		if err := o.field("lastEventAt", s.LastEventAt); err != nil {
			return nil, err
		}
	}
	if s.PendingPrompt != nil {
		if err := o.field("pendingPrompt", s.PendingPrompt); err != nil {
			return nil, err
		}
	}
	return o.bytes(), nil
}

func (s *AgentStatus) UnmarshalJSON(data []byte) error {
	var wire struct {
		Kind            string         `json:"kind"`
		LastTurnOutcome *TurnOutcome   `json:"lastTurnOutcome"`
		SinceSeq        int64          `json:"sinceSeq"`
		RequestID       string         `json:"requestId"`
		InputID         string         `json:"inputId"`
		Stop            *TurnStop      `json:"stop"`
		Phase           RunningPhase   `json:"phase"`
		LastEventAt     int64          `json:"lastEventAt"`
		PendingPrompt   *PendingPrompt `json:"pendingPrompt"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*s = AgentStatus(wire)
	return nil
}
