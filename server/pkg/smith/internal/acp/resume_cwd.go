package acp

import (
	"context"
	"path/filepath"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

func real(dir string) string {
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		if absolute, err := filepath.Abs(resolved); err == nil {
			return absolute
		}
	}
	absolute, _ := filepath.Abs(dir)
	return absolute
}

// sameDirectory reports the same directory, spelled or linked differently.
func sameDirectory(left, right string) bool {
	leftAbs, _ := filepath.Abs(left)
	rightAbs, _ := filepath.Abs(right)
	return leftAbs == rightAbs || real(left) == real(right)
}

// RefuseResumeElsewhere refuses a resume naming another cwd than the
// session's own with UnsupportedOptionError (resume-cwd.ts). It answers
// true when found, false only after a complete, well-formed list, nil when
// absence is unknown. Listing failures propagate unchanged; they never prove
// a session missing.
func RefuseResumeElsewhere(ctx context.Context, process *Process, sessionID, cwd string, timeout time.Duration) (*bool, error) {
	yes, no := true, false
	cursor := ""
	visited := map[string]bool{}
	complete := true
	for {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		answer, err := process.Request(ctx, MethodSessionList, params, timeout)
		if err != nil {
			return nil, err
		}
		page := jsonx.ParseRecord(answer)
		rawSessions, isList := page["sessions"].([]any)
		sessions := jsonx.AsRecordList(page["sessions"])
		if !isList || len(sessions) != len(rawSessions) {
			complete = false
		}
		for _, session := range sessions {
			if id, ok := session["sessionId"].(string); !ok || id == "" {
				complete = false
			}
		}
		for _, session := range sessions {
			if session["sessionId"] != sessionID {
				continue
			}
			if found, ok := session["cwd"].(string); ok && !sameDirectory(found, cwd) {
				return nil, &oar.UnsupportedOptionError{Option: "cwd", Message: "session " + sessionID + " lives in " + found + " and this runtime resumes it only there; the resume names " + cwd}
			}
			return &yes, nil
		}
		next, present := page["nextCursor"]
		if present && next != nil {
			text, ok := next.(string)
			if !ok {
				return nil, nil
			}
			cursor = text
		} else {
			cursor = ""
		}
		if cursor == "" {
			break
		}
		if visited[cursor] {
			return nil, nil
		}
		visited[cursor] = true
	}
	if complete {
		return &no, nil
	}
	return nil, nil
}
