package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

type issueActionView struct {
	Act    string `json:"act"`
	Does   string `json:"does"`
	Status string `json:"status,omitempty"`
	Words  string `json:"words,omitempty"`
}

type issueView struct {
	ID          string `json:"id"`
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Repo        string `json:"repo"`
	RepoID      string `json:"repoId"`
	AssigneeID  string `json:"assigneeId"`
	Priority    string `json:"priority"`
	Status      string `json:"status"`
	Assignments []struct {
		Agent      string `json:"agent"`
		Executions []struct {
			Kind    string `json:"kind"`
			Session string `json:"session"`
		} `json:"executions"`
	} `json:"assignments"`
	Criteria  []string `json:"criteria"`
	Questions []struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	} `json:"questions"`
	Stage struct {
		State string            `json:"state"`
		Stuck string            `json:"stuck"`
		Lead  string            `json:"lead"`
		Acts  []issueActionView `json:"acts"`
	} `json:"stage"`
}

func trimIssueRef(raw string) string {
	return strings.TrimPrefix(strings.TrimSpace(raw), "#")
}

func issueAgent(v issueView) string {
	if len(v.Assignments) > 0 {
		if a := strings.TrimSpace(v.Assignments[len(v.Assignments)-1].Agent); a != "" {
			return a
		}
	}
	return strings.TrimSpace(v.AssigneeID)
}

func issueRepo(v issueView) string {
	if strings.TrimSpace(v.Repo) != "" {
		return v.Repo
	}
	return v.RepoID
}

func formatIssueLine(v issueView) string {
	label := v.ID
	if v.Number > 0 {
		label = fmt.Sprintf("#%d", v.Number)
	}
	parts := []string{label, v.Status, v.Title}
	if a := issueAgent(v); a != "" {
		parts = append(parts, "@"+a)
	}
	if r := issueRepo(v); r != "" {
		parts = append(parts, "["+r+"]")
	}
	return strings.Join(parts, "  ")
}

func formatIssueDetail(v issueView) string {
	var b strings.Builder
	label := v.ID
	if v.Number > 0 {
		label = fmt.Sprintf("#%d", v.Number)
	}
	fmt.Fprintf(&b, "%s  %s\n", label, v.Title)
	meta := []string{v.Status}
	if v.Priority != "" {
		meta = append(meta, v.Priority)
	}
	if r := issueRepo(v); r != "" {
		meta = append(meta, "["+r+"]")
	}
	if a := issueAgent(v); a != "" {
		meta = append(meta, "@"+a)
	}
	b.WriteString(strings.Join(meta, "  "))
	if v.Stage.State != "" {
		b.WriteString("\nstage: ")
		b.WriteString(v.Stage.State)
		if v.Stage.Stuck != "" {
			fmt.Fprintf(&b, " (%s)", v.Stage.Stuck)
		}
	}
	if desc := strings.TrimSpace(v.Description); desc != "" {
		b.WriteString("\n\n")
		b.WriteString(desc)
	}
	if len(v.Criteria) > 0 {
		b.WriteString("\n\ncriteria:")
		for i, c := range v.Criteria {
			fmt.Fprintf(&b, "\n  %d. %s", i+1, c)
		}
	}
	if len(v.Questions) > 0 {
		b.WriteString("\n\nquestions:")
		for _, q := range v.Questions {
			fmt.Fprintf(&b, "\n  ? %s", q.Question)
			if len(q.Options) > 0 {
				fmt.Fprintf(&b, "  (%s)", strings.Join(q.Options, " | "))
			}
		}
	}
	return b.String()
}

func newIssueCommand(rt *appRuntime) *cobra.Command {
	issueCmd := &cobra.Command{
		Use:   "issue",
		Short: "Manage VibeValley issues",
	}

	var (
		listStatus    string
		listRepo      string
		listText      string
		listWantsUser bool
		listClosed    bool
		listLimit     int
	)
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List issues",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{}
			if listStatus != "" {
				req["status"] = listStatus
			}
			if listRepo != "" {
				req["repo"] = listRepo
			}
			if listText != "" {
				req["text"] = listText
			}
			if listWantsUser {
				req["wantsUser"] = true
			}
			if listClosed {
				req["closed"] = true
			}
			if listLimit > 0 {
				req["limit"] = listLimit
			}
			var items []issueView
			raw, err := client.Call(cmd.Context(), "issue.list", req, &items)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, items), func() string {
				if len(items) == 0 {
					return "no issues"
				}
				lines := make([]string, 0, len(items))
				for _, item := range items {
					lines = append(lines, formatIssueLine(item))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	listCmd.Flags().StringVar(&listStatus, "status", "", "filter by issue status")
	listCmd.Flags().StringVar(&listRepo, "repo", "", "filter by repository id or name")
	listCmd.Flags().StringVar(&listText, "text", "", "filter by text")
	listCmd.Flags().BoolVar(&listWantsUser, "wants-user", false, "filter issues waiting on user input")
	listCmd.Flags().BoolVar(&listClosed, "closed", false, "include closed issues")
	listCmd.Flags().IntVar(&listLimit, "limit", 20, "maximum number of issues to return")

	getCmd := &cobra.Command{
		Use:     "get <id>",
		Aliases: []string{"show"},
		Short:   "Show details for an issue",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var item issueView
			raw, err := client.Call(cmd.Context(), "issue.get", map[string]string{"id": trimIssueRef(args[0])}, &item)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, item), func() string {
				return formatIssueDetail(item)
			})
		},
	}

	var (
		createTitle    string
		createDesc     string
		createRepo     string
		createAgent    string
		createPriority string
		createCriteria []string
		createDeliver  string
		createKey      string
	)
	createCmd := &cobra.Command{
		Use:   "create [title...]",
		Short: "Create a new issue",
		RunE: func(cmd *cobra.Command, args []string) error {
			title := strings.TrimSpace(createTitle)
			if len(args) > 0 {
				title = strings.TrimSpace(strings.Join(args, " "))
			}
			if title == "" {
				return errors.New("issue title is required")
			}
			desc := createDesc
			if desc == "-" {
				var err error
				desc, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			req := map[string]any{"title": title}
			if desc != "" {
				req["description"] = desc
			}
			if createRepo != "" {
				req["repo"] = createRepo
			}
			if createAgent != "" {
				req["agent"] = createAgent
			}
			if createPriority != "" {
				req["priority"] = createPriority
			}
			if len(createCriteria) > 0 {
				req["criteria"] = createCriteria
			}
			if createDeliver != "" {
				req["deliver"] = createDeliver
			}
			if createKey != "" {
				req["requestKey"] = createKey
			}

			var created issueView
			raw, dry, err := rt.callMutate(cmd.Context(), "issue.create", req, &created)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, created), func() string {
				return formatIssueLine(created)
			})
		},
	}
	createCmd.Flags().StringVar(&createTitle, "title", "", "issue title (alternative to positional args)")
	createCmd.Flags().StringVar(&createDesc, "description", "", "issue description (use '-' to read stdin)")
	createCmd.Flags().StringVar(&createRepo, "repo", "", "target repository id or name")
	createCmd.Flags().StringVar(&createAgent, "agent", "", "assigned agent profile")
	createCmd.Flags().StringVar(&createPriority, "priority", "", "priority (urgent|high|medium|low)")
	createCmd.Flags().StringArrayVar(&createCriteria, "criterion", nil, "acceptance criterion (repeatable)")
	createCmd.Flags().StringVar(&createDeliver, "deliver", "", "deliverable kind (change|branch|answer|pull_request)")
	createCmd.Flags().StringVar(&createKey, "key", "", "idempotency requestKey")

	var (
		statusComment string
		statusAgent   string
		statusKey     string
	)
	statusCmd := &cobra.Command{
		Use:   "status <id> <status>",
		Short: "Transition an issue to a new status",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			req := map[string]any{
				"id":     trimIssueRef(args[0]),
				"status": strings.TrimSpace(args[1]),
			}
			if statusComment != "" {
				req["text"] = statusComment
			}
			if statusAgent != "" {
				req["agent"] = statusAgent
			}
			if statusKey != "" {
				req["requestKey"] = statusKey
			}
			var updated issueView
			raw, dry, err := rt.callMutateWithFallback(cmd.Context(), "issue.status.update", "issue.status", req, req, &updated)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, updated), func() string {
				return formatIssueLine(updated)
			})
		},
	}
	statusCmd.Flags().StringVar(&statusComment, "comment", "", "status transition comment or findings")
	statusCmd.Flags().StringVar(&statusAgent, "agent", "", "agent profile for dispatch")
	statusCmd.Flags().StringVar(&statusKey, "key", "", "idempotency requestKey")

	deleteCmd := &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete an issue",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := trimIssueRef(args[0])
			raw, dry, err := rt.callMutate(cmd.Context(), "issue.delete", map[string]string{"id": id}, nil)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"deleted": true, "id": id}),
				func() string { return fmt.Sprintf("deleted issue #%s", id) },
			)
		},
	}

	var (
		watchFollow bool
		watchJSONL  bool
	)
	watchCmd := &cobra.Command{
		Use:   "watch <id>",
		Short: "Stream SSE events for an issue until terminal state or cancellation",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			id := resolveIssueID(cmd.Context(), client, args[0])
			return rt.watchIssueSSE(cmd.Context(), client, id, watchFollow, watchJSONL || rt.isJSON())
		},
	}
	watchCmd.Flags().BoolVar(&watchFollow, "follow", false, "keep watching even after settled state")
	watchCmd.Flags().BoolVar(&watchJSONL, "jsonl", false, "output one JSON object per line")

	assignCmd := &cobra.Command{
		Use:   "assign <id> <agentId>",
		Short: "Assign an agent profile to an issue",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := trimIssueRef(args[0])
			agentID := strings.TrimSpace(args[1])
			if agentID == "" {
				return errors.New("agentId is required")
			}
			req := map[string]any{
				"id":    id,
				"agent": agentID,
			}
			var updated issueView
			raw, dry, err := rt.callMutate(cmd.Context(), "issue.update", req, &updated)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, updated), func() string {
				return formatIssueLine(updated)
			})
		},
	}

	var (
		actText    string
		actComment string
	)
	actCmd := &cobra.Command{
		Use:   "act <id> <action> [text...]",
		Short: "Perform a stage action on an issue (e.g. start, complete, close, tell, stop, reopen)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := trimIssueRef(args[0])
			action := strings.TrimSpace(args[1])
			text := strings.TrimSpace(actText)
			if text == "" {
				text = strings.TrimSpace(actComment)
			}
			if text == "" && len(args) > 2 {
				text = strings.TrimSpace(strings.Join(args[2:], " "))
			}
			return rt.runIssueAct(cmd.Context(), id, action, text)
		},
	}
	actCmd.Flags().StringVar(&actText, "text", "", "message or status comment for the action")
	actCmd.Flags().StringVar(&actComment, "comment", "", "comment text (alias for --text)")

	var (
		refineInstruction string
		refineText        string
	)
	refineCmd := &cobra.Command{
		Use:   "refine <id>",
		Short: "Refine an issue specification and acceptance criteria",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := trimIssueRef(args[0])
			instruction := refineInstruction
			if instruction == "-" {
				var err error
				instruction, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			instruction = strings.TrimSpace(instruction)
			if instruction == "" {
				instruction = strings.TrimSpace(refineText)
			}
			req := map[string]any{"id": id}
			if instruction != "" {
				req["text"] = instruction
			}
			var refined issueView
			raw, dry, err := rt.callMutate(cmd.Context(), "issue.refine", req, &refined)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, refined), func() string {
				return formatIssueLine(refined)
			})
		},
	}
	refineCmd.Flags().StringVar(&refineInstruction, "instruction", "", "refinement instruction (use '-' to read stdin)")
	refineCmd.Flags().StringVar(&refineText, "text", "", "refinement instruction (alias for --instruction)")

	issueCmd.AddCommand(listCmd, getCmd, createCmd, statusCmd, deleteCmd, watchCmd, assignCmd, actCmd, refineCmd)
	return issueCmd
}

var errWatchDone = errors.New("watch complete")

func (rt *appRuntime) watchIssueSSE(ctx context.Context, client *Client, id string, follow, jsonl bool) error {
	watchPath := "/api/v1/issue/watch/" + url.PathEscape(id)
	resp, err := client.OpenSSE(ctx, watchPath)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var lastState string
	seenEvents := make(map[string]map[int64]int64)
	lastGaps := make(map[string]string)

	err = readSSEEvents(ctx, resp.Body, func(eventType, data string) error {
		trimmed := strings.TrimSpace(data)
		if trimmed == "" {
			return nil
		}
		if eventType == "done" || eventType == "closed" {
			return errWatchDone
		}

		var envelope struct {
			Kind    string            `json:"kind"`
			Type    string            `json:"type"`
			Status  string            `json:"status"`
			IssueID string            `json:"issue"`
			Session string            `json:"session"`
			Before  *int64            `json:"before"`
			Settled bool              `json:"settled"`
			Event   json.RawMessage   `json:"event"`
			Events  []json.RawMessage `json:"events"`
		}
		// Inspect kind carefully because "issue" is a string on "missing" and an object on "state".
		var rawMap map[string]json.RawMessage
		if jErr := json.Unmarshal([]byte(trimmed), &rawMap); jErr != nil {
			_, _ = fmt.Fprintln(rt.stdout, trimmed)
			return nil
		}

		_ = json.Unmarshal([]byte(trimmed), &envelope)
		switch envelope.Kind {
		case "history":
			for _, evRaw := range envelope.Events {
				if acceptWatchEvent(seenEvents, envelope.Session, evRaw) {
					rowJSON := buildWatchEventRow(envelope.Session, evRaw)
					if err := rt.writeWatchLine(jsonl, rowJSON, formatWatchEventText(envelope.Session, evRaw)); err != nil {
						return err
					}
				}
			}
			return nil
		case "event":
			if !acceptWatchEvent(seenEvents, envelope.Session, envelope.Event) {
				return nil
			}
			if err := rt.writeWatchLine(jsonl, trimmed, formatWatchEventText(envelope.Session, envelope.Event)); err != nil {
				return err
			}
			var evObj struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(envelope.Event, &evObj)
			if !follow && (evObj.Type == "done" || evObj.Type == "closed") {
				return errWatchDone
			}
			return nil
		case "gap":
			if lastGaps[envelope.Session] == trimmed {
				return nil
			}
			lastGaps[envelope.Session] = trimmed
			msg := fmt.Sprintf("%s  events unavailable", envelope.Session)
			if envelope.Before != nil {
				msg = fmt.Sprintf("%s  gap before seq %d", envelope.Session, *envelope.Before)
			}
			return rt.writeWatchLine(jsonl, trimmed, msg)
		case "missing":
			var missingIssue string
			_ = json.Unmarshal(rawMap["issue"], &missingIssue)
			if missingIssue == "" {
				missingIssue = id
			}
			if err := rt.writeWatchLine(jsonl, trimmed, fmt.Sprintf("issue %s missing", missingIssue)); err != nil {
				return err
			}
			return errWatchDone
		case "state":
			if trimmed == lastState {
				return nil
			}
			lastState = trimmed
			var iss issueView
			_ = json.Unmarshal(rawMap["issue"], &iss)
			textLine := formatIssueWatchState(iss, id)
			if err := rt.writeWatchLine(jsonl, trimmed, textLine); err != nil {
				return err
			}
			terminal := envelope.Settled || iss.Status == "done" || iss.Status == "canceled" || iss.Status == "in_review"
			if !follow && terminal {
				return errWatchDone
			}
			return nil
		default:
			if err := rt.writeWatchLine(jsonl, trimmed, formatGenericWatchText(trimmed)); err != nil {
				return err
			}
			terminal := envelope.Kind == "done" || envelope.Kind == "closed" ||
				envelope.Type == "done" || envelope.Type == "closed" ||
				envelope.Status == "done" || envelope.Status == "canceled"
			if !follow && terminal {
				return errWatchDone
			}
			return nil
		}
	})
	if errors.Is(err, errWatchDone) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (rt *appRuntime) writeWatchLine(jsonl bool, rawJSON, textLine string) error {
	if jsonl {
		_, err := fmt.Fprintln(rt.stdout, rawJSON)
		return err
	}
	if strings.TrimSpace(textLine) == "" {
		return nil
	}
	_, err := fmt.Fprintln(rt.stdout, textLine)
	return err
}

func acceptWatchEvent(seen map[string]map[int64]int64, session string, evRaw json.RawMessage) bool {
	var ev struct {
		Seq      int64 `json:"seq"`
		Revision int64 `json:"revision"`
	}
	if json.Unmarshal(evRaw, &ev) != nil {
		return true
	}
	perSess := seen[session]
	if perSess == nil {
		perSess = make(map[int64]int64)
		seen[session] = perSess
	}
	if prevRev, ok := perSess[ev.Seq]; ok && prevRev >= ev.Revision {
		return false
	}
	perSess[ev.Seq] = ev.Revision
	return true
}

func buildWatchEventRow(session string, evRaw json.RawMessage) string {
	b, err := json.Marshal(map[string]any{
		"kind":    "event",
		"session": session,
		"event":   evRaw,
	})
	if err != nil {
		return string(evRaw)
	}
	return string(b)
}

func formatWatchEventText(session string, evRaw json.RawMessage) string {
	var ev struct {
		Seq        int64  `json:"seq"`
		Revision   int64  `json:"revision"`
		Type       string `json:"type"`
		ActionText string `json:"actionText"`
		Tool       string `json:"tool"`
		Text       string `json:"text"`
		Input      string `json:"input"`
		Output     string `json:"output"`
		Ok         *bool  `json:"ok"`
	}
	if json.Unmarshal(evRaw, &ev) != nil {
		return strings.TrimSpace(string(evRaw))
	}
	parts := []string{
		session,
		fmt.Sprintf("%d.%d", ev.Seq, ev.Revision),
		ev.Type,
	}
	for _, v := range []string{ev.Tool, ev.ActionText, ev.Text, ev.Input, ev.Output} {
		if strings.TrimSpace(v) != "" {
			parts = append(parts, strings.Join(strings.Fields(v), " "))
		}
	}
	if ev.Ok != nil {
		parts = append(parts, fmt.Sprintf("ok=%t", *ev.Ok))
	}
	return strings.Join(parts, "  ")
}

func formatIssueWatchState(iss issueView, fallbackID string) string {
	label := iss.ID
	if label == "" {
		label = fallbackID
	}
	if iss.Number > 0 {
		label = fmt.Sprintf("#%d", iss.Number)
	}
	parts := []string{label}
	if iss.Status != "" {
		parts = append(parts, iss.Status)
	}
	if iss.Stage.State != "" {
		st := "stage=" + iss.Stage.State
		if iss.Stage.Stuck != "" {
			st += "(" + iss.Stage.Stuck + ")"
		}
		parts = append(parts, st)
	}
	if iss.Title != "" {
		parts = append(parts, iss.Title)
	}
	return strings.Join(parts, "  ")
}

func formatGenericWatchText(raw string) string {
	var m map[string]any
	if json.Unmarshal([]byte(raw), &m) != nil {
		return raw
	}
	parts := make([]string, 0, 4)
	for _, k := range []string{"kind", "type", "status", "message", "text"} {
		if v, ok := m[k]; ok && fmt.Sprint(v) != "" {
			parts = append(parts, fmt.Sprintf("%s=%v", k, v))
		}
	}
	if len(parts) == 0 {
		return raw
	}
	return strings.Join(parts, "  ")
}

type issueActPlan struct {
	Op         string
	FallbackOp string
	Body       map[string]any
}

func planIssueActFallback(id, action, text, sessionID string) (issueActPlan, error) {
	actLower := strings.ToLower(strings.TrimSpace(action))
	switch actLower {
	case "start", "reopen", "cure", "resume", "resolve":
		body := map[string]any{"id": id, "status": "todo"}
		if text != "" {
			body["text"] = text
		}
		return issueActPlan{Op: "issue.status.update", FallbackOp: "issue.status", Body: body}, nil
	case "complete", "acknowledge":
		body := map[string]any{"id": id, "status": "done"}
		if text != "" {
			body["text"] = text
		}
		return issueActPlan{Op: "issue.status.update", FallbackOp: "issue.status", Body: body}, nil
	case "close":
		body := map[string]any{"id": id, "status": "canceled"}
		if text != "" {
			body["text"] = text
		}
		return issueActPlan{Op: "issue.status.update", FallbackOp: "issue.status", Body: body}, nil
	case "tell", "answer":
		if text == "" {
			return issueActPlan{}, fmt.Errorf("action %q requires --text or --comment", action)
		}
		return issueActPlan{
			Op:   "issue.comment.create",
			Body: map[string]any{"id": id, "text": text},
		}, nil
	case "reject":
		body := map[string]any{"id": id, "pass": false}
		if text != "" {
			body["text"] = text
		}
		return issueActPlan{Op: "issue.review", Body: body}, nil
	case "stop":
		target := sessionID
		if target == "" {
			target = id
		}
		return issueActPlan{Op: "session.stop", Body: map[string]any{"id": target}}, nil
	default:
		return issueActPlan{}, fmt.Errorf("unknown issue action %q", action)
	}
}

func latestIssueWorkerSession(iss issueView) string {
	for i := len(iss.Assignments) - 1; i >= 0; i-- {
		a := iss.Assignments[i]
		for j := len(a.Executions) - 1; j >= 0; j-- {
			if a.Executions[j].Kind == "worker" && a.Executions[j].Session != "" {
				return a.Executions[j].Session
			}
		}
	}
	return ""
}

func (rt *appRuntime) runIssueAct(ctx context.Context, id, action, text string) error {
	if rt.dryRun {
		plan, err := planIssueActFallback(id, action, text, "")
		if err != nil {
			return err
		}
		return rt.writeDryRun(http.MethodPost, opPath(plan.Op), plan.Body)
	}

	client, _, err := rt.newClient()
	if err != nil {
		return err
	}

	var iss issueView
	var haveIssue bool
	if _, gErr := client.Call(ctx, "issue.get", map[string]string{"id": id}, &iss); gErr == nil {
		haveIssue = true
	} else {
		var apiErr *APIError
		if !errors.As(gErr, &apiErr) || !apiErr.isNotFound() || apiErr.BizCode == 300001 {
			return gErr
		}
	}

	var plan issueActPlan
	if haveIssue && len(iss.Stage.Acts) > 0 {
		var matched *issueActionView
		avail := make([]string, 0, len(iss.Stage.Acts))
		for i := range iss.Stage.Acts {
			a := &iss.Stage.Acts[i]
			avail = append(avail, a.Act)
			if strings.EqualFold(a.Act, action) {
				matched = a
			}
		}
		if matched == nil {
			return fmt.Errorf("action %q is not available in stage %q (available: %s)", action, iss.Stage.State, strings.Join(avail, ", "))
		}
		switch matched.Does {
		case "move":
			if matched.Words == "required" && text == "" {
				return fmt.Errorf("action %q requires --text or --comment", action)
			}
			body := map[string]any{"id": id, "status": matched.Status}
			if text != "" {
				body["text"] = text
			}
			plan = issueActPlan{Op: "issue.status.update", FallbackOp: "issue.status", Body: body}
		case "say":
			if text == "" {
				return fmt.Errorf("action %q requires --text or --comment", action)
			}
			plan = issueActPlan{Op: "issue.comment.create", Body: map[string]any{"id": id, "text": text}}
		case "stop":
			sessID := latestIssueWorkerSession(iss)
			if sessID == "" {
				return fmt.Errorf("no active worker session on issue %s to stop", id)
			}
			plan = issueActPlan{Op: "session.stop", Body: map[string]any{"id": sessID}}
		default:
			return fmt.Errorf("unsupported action kind %q for %q", matched.Does, action)
		}
	} else {
		sessID := ""
		if haveIssue {
			sessID = latestIssueWorkerSession(iss)
		}
		plan, err = planIssueActFallback(id, action, text, sessID)
		if err != nil {
			return err
		}
	}

	var raw json.RawMessage
	if plan.FallbackOp != "" {
		raw, err = client.CallWithFallback(ctx, plan.Op, plan.FallbackOp, plan.Body, plan.Body, nil)
	} else {
		raw, err = client.Call(ctx, plan.Op, plan.Body, nil)
	}
	if err != nil {
		return err
	}

	var updated issueView
	if len(raw) > 0 && json.Unmarshal(raw, &updated) == nil && (updated.ID != "" || updated.Title != "") {
		return rt.writeOutput(rawOrValue(raw, updated), func() string {
			return formatIssueLine(updated)
		})
	}
	return rt.writeOutput(
		rawOrValue(raw, map[string]any{"ok": true, "id": id, "action": action}),
		func() string { return fmt.Sprintf("%s #%s", action, id) },
	)
}

func rawOrValue(raw json.RawMessage, fallback any) any {
	if len(strings.TrimSpace(string(raw))) > 0 {
		return raw
	}
	return fallback
}

func resolveIssueID(ctx context.Context, client *Client, rawRef string) string {
	ref := trimIssueRef(rawRef)
	if ref == "" || client == nil {
		return ref
	}
	var iss issueView
	if _, err := client.Call(ctx, "issue.get", map[string]string{"id": ref}, &iss); err == nil && iss.ID != "" {
		return iss.ID
	}
	if num, err := strconv.Atoi(ref); err == nil && num > 0 {
		for _, closed := range []bool{false, true} {
			var list []issueView
			if _, lErr := client.Call(ctx, "issue.list", map[string]any{"closed": closed, "limit": 200}, &list); lErr == nil {
				for _, item := range list {
					if item.Number == num && item.ID != "" {
						return item.ID
					}
				}
			}
		}
	}
	return ref
}
