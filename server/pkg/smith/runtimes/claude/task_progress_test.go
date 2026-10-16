//go:build wip_b

package claude

import (
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-task-progress.test.ts.

func b_taskReader() func(message map[string]any) []oar.EventBody {
	state := initialClaudeProjection()
	return func(message map[string]any) []oar.EventBody {
		frame := map[string]any{"type": "system", "task_id": "task"}
		for key, value := range message {
			frame[key] = value
		}
		var commands []projectionCommand
		state, commands = fold(state, frame)
		events := []oar.EventBody{}
		for _, command := range commands {
			if command.Kind == "frame" {
				events = append(events, command.Body.Events...)
			}
		}
		return events
	}
}

func TestTaskTypesMapAndReportOnlyDescriptionChanges(t *testing.T) {
	for _, tc := range [][2]string{
		{"local_bash", "shell"}, {"local_agent", "agent"}, {"remote_agent", "agent"},
		{"in_process_teammate", "agent"}, {"mcp_task", "tool"}, {"local_workflow", "workflow"}, {"future_type", "other"},
	} {
		t.Run(tc[0], func(t *testing.T) {
			read := b_taskReader()
			assertJSON(t, read(map[string]any{"subtype": "task_started", "task_type": tc[0], "description": "one"}),
				`[{"kind":"task_started","taskId":"task","taskType":"`+tc[1]+`","nativeType":"`+tc[0]+`","description":"one"}]`)
			assertJSON(t, read(map[string]any{"subtype": "task_progress", "description": "one", "usage": map[string]any{"total_tokens": 500}}), `[]`)
			assertJSON(t, read(map[string]any{"subtype": "task_progress", "description": "two"}), `[{"kind":"task_updated","taskId":"task","description":"two"}]`)
			assertJSON(t, read(map[string]any{"subtype": "task_updated", "patch": map[string]any{"description": "three"}}), `[{"kind":"task_updated","taskId":"task","description":"three"}]`)
			assertJSON(t, read(map[string]any{"subtype": "task_progress", "description": "three"}), `[]`)
			assertJSON(t, read(map[string]any{"subtype": "task_progress", "description": ""}), `[{"kind":"task_updated","taskId":"task","description":""}]`)
			assertJSON(t, read(map[string]any{"subtype": "task_progress", "description": ""}), `[]`)
		})
	}
}

func TestProgressIdentityIsPerAgentAndTask(t *testing.T) {
	read := b_taskReader()
	progress := func(extra map[string]any) map[string]any {
		frame := map[string]any{"subtype": "task_progress", "description": "same"}
		for key, value := range extra {
			frame[key] = value
		}
		return frame
	}
	for _, extra := range []map[string]any{nil, {"task_id": "other"}, {"parent_tool_use_id": "child"}} {
		if events := read(progress(extra)); len(events) != 1 {
			t.Fatalf("%v: events = %v", extra, events)
		}
	}
	assertJSON(t, read(progress(nil)), `[]`)
	assertJSON(t, read(progress(map[string]any{"task_id": nil})), `[]`)
	assertJSON(t, read(map[string]any{"subtype": "task_progress", "description": nil, "last_tool_name": "Bash", "summary": "not the description"}), `[]`)
	assertJSON(t, read(map[string]any{"subtype": "task_progress"}), `[]`)
}
