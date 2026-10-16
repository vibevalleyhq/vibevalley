package claude

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// claude's task frames (tasks.ts; stream-json system/task_started,
// task_updated, task_progress, task_notification; observed on 2.1.284 and
// 2.1.292): background and foreground commands (local_bash), subagents
// (local_agent, remote_agent), MCP calls moved to the background
// (mcp_task), workflow runs (local_workflow) and agent teammates.
// workflow_progress stays native: it is outside the SDK schema. Its
// last-call token counts are not spend; only result.modelUsage is.
// background_tasks_changed repeats the live set and maps to nothing.

var claudeTaskTypes = map[string]oar.TaskType{
	"local_bash":          "shell",
	"local_agent":         "agent",
	"remote_agent":        "agent",
	"in_process_teammate": "agent",
	"mcp_task":            "tool",
	"local_workflow":      "workflow",
}

var claudeTaskStatuses = map[string]oar.TaskStatus{
	"pending":   "pending",
	"running":   "running",
	"paused":    "paused",
	"completed": "completed",
	"failed":    "failed",
	"killed":    "stopped",
	"stopped":   "stopped",
}

// taskText is a non-empty string, "" otherwise.
func taskText(value any) string {
	text, _ := value.(string)
	return text
}

func taskFlag(value any) *bool {
	flag, ok := value.(bool)
	if !ok {
		return nil
	}
	return &flag
}

func taskStarted(message jsonx.Record, taskID string) oar.EventBody {
	nativeType := taskText(message["task_type"])
	taskType, known := claudeTaskTypes[nativeType]
	if !known {
		taskType = "other"
	}
	return oar.TaskStarted{
		TaskID:      taskID,
		TaskType:    taskType,
		NativeType:  nativeType,
		Description: taskText(message["description"]),
		ToolCallID:  taskText(message["tool_use_id"]),
		Background:  taskFlag(message["is_backgrounded"]),
		Ambient:     taskFlag(message["ambient"]),
	}
}

func taskUpdated(message jsonx.Record, taskID string) oar.TaskUpdated {
	patch := jsonx.AsRecord(message["patch"])
	update := oar.TaskUpdated{TaskID: taskID, Background: taskFlag(patch["is_backgrounded"])}
	if status, ok := patch["status"].(string); ok {
		update.Status = claudeTaskStatuses[status]
	}
	if description := taskText(patch["description"]); description != "" {
		update.Description = &description
	}
	if failure := taskText(patch["error"]); failure != "" {
		update.Error = &failure
	}
	return update
}

func taskEnded(message jsonx.Record, taskID string) []oar.EventBody {
	status := ""
	if native, ok := message["status"].(string); ok {
		status = claudeTaskStatuses[native]
	}
	if status != "completed" && status != "failed" && status != "stopped" {
		return nil
	}
	return []oar.EventBody{oar.TaskEnded{TaskID: taskID, Status: status, Summary: taskText(message["summary"]), OutputFile: taskText(message["output_file"])}}
}

func taskEvents(message jsonx.Record, previousDescription *string) []oar.EventBody {
	taskID := taskText(message["task_id"])
	if taskID == "" {
		return nil
	}
	switch message["subtype"] {
	case "task_started":
		return []oar.EventBody{taskStarted(message, taskID)}
	case "task_updated":
		return []oar.EventBody{taskUpdated(message, taskID)}
	case "task_progress":
		description, ok := message["description"].(string)
		if ok && (previousDescription == nil || description != *previousDescription) {
			return []oar.EventBody{oar.TaskUpdated{TaskID: taskID, Description: &description}}
		}
		return nil
	case "task_notification":
		return taskEnded(message, taskID)
	}
	return nil
}

// claudeTaskViews reads a task frame. Progress repeats often; each task's
// last reported description is remembered across turns. descriptions is
// never modified: a changed map is a copy.
func claudeTaskViews(message jsonx.Record, descriptions map[string]string, agentPath []string) ([]oar.EventBody, map[string]string) {
	key := jsonText(append(append([]any{}, stringsToAny(agentPath)...), message["task_id"]))
	var previous *string
	if known, ok := descriptions[key]; ok {
		previous = &known
	}
	events := taskEvents(message, previous)
	var description *string
	for _, event := range events {
		if typed, ok := event.(oar.TaskStarted); ok && typed.Description != "" {
			text := typed.Description
			description = &text
		}
		if typed, ok := event.(oar.TaskUpdated); ok && typed.Description != nil {
			description = typed.Description
		}
		if description != nil {
			break
		}
	}
	if description != nil && (previous == nil || *description != *previous) {
		next := make(map[string]string, len(descriptions)+1)
		for name, value := range descriptions {
			next[name] = value
		}
		next[key] = *description
		return events, next
	}
	return events, descriptions
}

func stringsToAny(values []string) []any {
	out := make([]any, len(values))
	for index, value := range values {
		out[index] = value
	}
	return out
}
