package codex

import (
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// codexTaskViews reads a `subAgentActivity` item (tasks.ts). codex reports
// its subagents on the parent thread as `subAgentActivity` items (0.149.0 to
// 0.158.0): `kind` started, interacted, interrupted, and (0.158.0)
// completed, with the child's `agentThreadId` and its canonical `agentPath`
// (`/root/name`). The child thread is its own session, so it is the task id
// and the `childSessionId`. A codex subagent can be given more work after it
// completed, which `interacted` reports. The projection passes only items
// about the reporting thread's own child: a thread messaging the root or a
// sibling reports `interacted` too, and that changes no task.
func codexTaskViews(item jsonx.Record) []oar.EventBody {
	taskID, _ := item["agentThreadId"].(string)
	if item["type"] != "subAgentActivity" || taskID == "" {
		return nil
	}
	switch item["kind"] {
	case "started":
		started := oar.TaskStarted{TaskID: taskID, TaskType: "agent", NativeType: "subAgent", ChildSessionID: taskID, Background: oar.Bool(true)}
		if path, ok := item["agentPath"].(string); ok {
			started.Description = path
		}
		if id, ok := item["id"].(string); ok {
			started.ToolCallID = id
		}
		return []oar.EventBody{started}
	case "interacted":
		return []oar.EventBody{oar.TaskUpdated{TaskID: taskID, Status: "running"}}
	case "completed":
		return []oar.EventBody{oar.TaskEnded{TaskID: taskID, Status: "completed"}}
	case "interrupted":
		return []oar.EventBody{oar.TaskEnded{TaskID: taskID, Status: "stopped"}}
	}
	return nil
}

// subagentThread is a subagent thread as its `started` item reported it: the
// thread that started it, and its canonical path ("" when none).
type subagentThread struct {
	parent  string
	path    string
	hasPath bool
}

// subagentThreads are subagent threads by thread id, in the order they started.
// Never modified once built: a change makes a new value.
type subagentThreads struct {
	order   []string
	threads map[string]subagentThread
}

// rootPath is the root thread's canonical path (0.158.0: gamma's `interacted` naming the root says `/root`).
const rootPath = "/root"

// withStartedChild is threads plus the child a `started` item reported on reporter's thread names.
func withStartedChild(threads subagentThreads, reporter string, item jsonx.Record) subagentThreads {
	if item == nil || item["type"] != "subAgentActivity" || item["kind"] != "started" {
		return threads
	}
	child, ok := item["agentThreadId"].(string)
	if !ok || child == "" {
		return threads
	}
	if _, known := threads.threads[child]; known {
		return threads
	}
	entry := subagentThread{parent: reporter}
	if path, ok := item["agentPath"].(string); ok {
		entry.path, entry.hasPath = path, true
	}
	next := subagentThreads{order: append(append([]string(nil), threads.order...), child), threads: make(map[string]subagentThread, len(threads.threads)+1)}
	for id, thread := range threads.threads {
		next.threads[id] = thread
	}
	next.threads[child] = entry
	return next
}

// threadAt is the thread at a canonical path, when the stream has named it.
func threadAt(threads subagentThreads, rootThreadID, path string) (string, bool) {
	if path == rootPath {
		return rootThreadID, true
	}
	for _, id := range threads.order {
		if thread := threads.threads[id]; thread.hasPath && thread.path == path {
			return id, true
		}
	}
	return "", false
}

// childByPath says whether path names a child of reporter, judged by the
// parent path: decided when the parent path's thread is known, or when the
// reporter's own path is (then the parent is someone else); unknown (false
// second result) when neither is.
func childByPath(threads subagentThreads, rootThreadID, reporter, path string) (bool, bool) {
	parentPath := path
	if index := strings.LastIndex(path, "/"); index >= 0 {
		parentPath = path[:index]
	} else {
		// JS path.slice(0, -1) when "/" is absent.
		parentPath = path[:max(len(path)-1, 0)]
	}
	if parent, ok := threadAt(threads, rootThreadID, parentPath); ok {
		return parent == reporter, true
	}
	if reporter == rootThreadID || threads.threads[reporter].hasPath {
		return false, true
	}
	return false, false
}

// aboutOwnChild says whether a `subAgentActivity` item is about the
// reporting thread's own child. A thread reports `subAgentActivity` on its
// own thread for its own children and for the messages it sends to peers: on
// 0.158.0 alpha's `interacted /root/beta` (a sibling) and gamma's
// `interacted /root` (the root) arrived on alpha's and gamma's threads. Only
// an item about the reporting thread's own child is a task change or an
// edge. The child's recorded start decides; without one (started before a
// resume) its `agentPath` does; when neither the parent path's thread nor the
// reporter's path is known, the child is taken to be the reporter's.
func aboutOwnChild(threads subagentThreads, rootThreadID, reporter string, item jsonx.Record) bool {
	child, isString := item["agentThreadId"].(string)
	if item["kind"] == "started" || !isString {
		return item["kind"] == "started"
	}
	started, known := threads.threads[child]
	if child == rootThreadID || known {
		return known && started.parent == reporter
	}
	if path, ok := item["agentPath"].(string); ok {
		if own, decided := childByPath(threads, rootThreadID, reporter, path); decided {
			return own
		}
	}
	return true
}
