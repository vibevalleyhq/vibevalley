package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"vibevalley/internal/protocol"
)

// How often `issue run` looks at the issue while it is worked.
var runPoll = 2 * time.Second

// issueRun is `vibevalley issue run <id>`: move a backlog issue to todo (issue.status), wait while it waits for room or is
// worked, then print its changes. One already sent is only waited for. It ends in review, done or canceled; each status
// it passes goes to stderr.
func issueRun(ctx context.Context, raw []string) error {
	a, err := parseArgs(raw)
	if err != nil {
		return err
	}
	if len(a.words) != 1 {
		return fmt.Errorf("用法：vibevalley issue run <id>")
	}
	c, id := client(a), a.words[0]
	issue, err := c.IssueGet(ctx, id)
	if err != nil {
		return err
	}
	if issue.Status == protocol.IssueStatusBacklog {
		if _, err := c.IssueStatus(ctx, id, protocol.IssueStatusRequest{Status: protocol.IssueStatusTodo}); err != nil {
			return err
		}
	}
	last := protocol.IssueStatus("")
	for {
		issue, err := c.IssueGet(ctx, id)
		if err != nil {
			return err
		}
		if issue.Status != last {
			fmt.Fprintln(os.Stderr, string(issue.Status))
			last = issue.Status
		}
		switch issue.Status {
		case protocol.IssueStatusInReview, protocol.IssueStatusDone, protocol.IssueStatusCanceled:
			changes, err := c.IssueChanges(ctx, id)
			if err != nil {
				return err
			}
			out, err := json.Marshal(changes)
			if err != nil {
				return err
			}
			return printJSON(os.Stdout, out)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(runPoll):
		}
	}
}
