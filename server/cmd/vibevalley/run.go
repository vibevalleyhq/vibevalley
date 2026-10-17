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

// issueRun is `vibevalley issue run <id>`: start the issue, wait while it is worked, then print its changes. It ends
// when the issue is queued (no room yet), in review, done or canceled; the issue's last status goes to stderr.
func issueRun(ctx context.Context, raw []string) error {
	a, err := parseArgs(raw)
	if err != nil {
		return err
	}
	if len(a.words) != 1 {
		return fmt.Errorf("用法：vibevalley issue run <id>")
	}
	c, id := client(a), a.words[0]
	got, err := c.IssueStart(ctx, id)
	if err != nil {
		return err
	}
	if got.Queued != nil {
		fmt.Fprintln(os.Stderr, *got.Queued)
		return nil
	}
	if got.Worker == nil {
		return fmt.Errorf("%s 交给了管家，看田头", id)
	}
	fmt.Fprintf(os.Stderr, "开工了：%s\n", *got.Worker)
	last := protocol.IssueStatus("")
	for {
		issue, err := c.IssueFind(ctx, id)
		if err != nil {
			return err
		}
		if issue.Status != last {
			fmt.Fprintln(os.Stderr, string(issue.Status))
			last = issue.Status
		}
		switch issue.Status {
		case protocol.IssueStatusInReview, protocol.IssueStatusDone, protocol.IssueStatusCanceled:
			changes, err := c.WorkerChanges(ctx, *got.Worker)
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
