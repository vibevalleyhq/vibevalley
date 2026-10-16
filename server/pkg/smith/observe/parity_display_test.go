package observe_test

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// displayOf mirrors generate.ts display(): the display helpers over the
// golden log's view, status steps and tasks.
func displayOf(t *testing.T, g golden, records []oar.RawEvent) any {
	t.Helper()
	runtimeID := g.RuntimeID
	view := observe.ViewOf(records, "")
	groups := []any{}
	tools := []any{}
	requests := []any{}
	notices := []observe.ViewNotice{}
	for _, message := range view.Messages {
		if message.Kind == "notice" {
			notices = append(notices, *message.Notice)
		}
		if message.Kind != "turn" {
			continue
		}
		for _, section := range message.Sections {
			segments := observe.GroupToolActivity(runtimeID, section.Parts)
			summaries := []any{}
			for _, segment := range segments {
				if segment.Kind != "tools" {
					summaries = append(summaries, nil)
					continue
				}
				summaries = append(summaries, map[string]string{
					"done":    observe.ToolGroupSummary(segment.Counts, "done"),
					"running": observe.ToolGroupSummary(segment.Counts, "running"),
				})
			}
			groups = append(groups, map[string]any{"segments": segments, "summaries": summaries})
			for _, part := range section.Parts {
				switch part.Kind {
				case "tool":
					input := part.Input
					if part.InputPartial {
						input = nil
					}
					action := observe.ClassifyTool(runtimeID, part.Tool, input)
					state := observe.ToolState("done")
					switch part.Result {
					case "running":
						state = "running"
					case "failed":
						state = "failed"
					}
					var shown any
					if part.Input != nil {
						shown = *part.Input
					}
					tools = append(tools, map[string]any{
						"tool": part.Tool, "input": shown, "action": action, "bare": observe.ClassifyTool(runtimeID, part.Tool, nil),
						"label": observe.ToolActionLabel(action.Kind, state), "writing": observe.ToolActionLabel(action.Kind, "writing"),
					})
				case "app_request":
					var text any
					var body json.RawMessage
					if part.HasBody {
						body = part.Body
					}
					if words, ok := observe.AppRequestText(part.Type, body); ok {
						text = words
					}
					requests = append(requests, map[string]any{"type": part.Type, "kind": observe.AppRequestKindOf(part.Type), "text": text})
				case "notice":
					notices = append(notices, *part.Notice)
				}
			}
		}
	}
	noticeRows := []any{}
	for _, notice := range notices {
		noticeRows = append(noticeRows, map[string]any{"notice": notice, "text": observe.NoticeText(notice), "tone": observe.NoticeToneOf(notice)})
	}
	phases := []any{}
	failures := []any{}
	status := observe.InitialStatus
	for _, record := range records {
		status = observe.ReduceStatus(status, record, g.RootSessionID)
		if status.IsRunning() {
			phases = append(phases, map[string]any{"phase": status.Phase, "label": observe.PhaseLabel(status.Phase, ""), "runtimeLabel": observe.PhaseLabel(status.Phase, runtimeID)})
		}
		if outcome := status.LastTurnOutcome; outcome != nil && outcome.Kind == "failed" && outcome.Failure != "" {
			advice, _ := observe.FailureAdviceOf(outcome.Failure)
			var credential any
			if outcome.Credential != "" {
				credential = outcome.Credential
			}
			failures = append(failures, map[string]any{"failure": outcome.Failure, "credential": credential,
				"text": observe.FailureText(outcome.Failure, "Runtime", outcome.Credential), "advice": advice})
		}
	}
	tasks := []string{}
	for _, task := range observe.TasksOf(records, "").Value {
		tasks = append(tasks, observe.TaskStatusLabel(task.Status))
	}
	return map[string]any{"groups": groups, "tools": tools, "requests": requests, "notices": noticeRows, "phases": phases, "failures": failures, "tasks": tasks}
}
