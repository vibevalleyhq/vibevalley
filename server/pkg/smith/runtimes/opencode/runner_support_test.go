package opencode

// The package's seams, replaced per test (TS: vi.mock of runExecutable and acpSession).

import (
	"context"
	"sync"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

type runCall struct {
	command string
	args    []string
	options executable.RunOptions
}

// recordingRunner answers each call with the next of results (the last repeats) and records it.
type recordingRunner struct {
	mu      sync.Mutex
	calls   []runCall
	results []executable.Result
}

func (r *recordingRunner) run(_ context.Context, command string, args []string, options executable.RunOptions) executable.Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, runCall{command, append([]string{}, args...), options})
	if len(r.results) == 0 {
		return executable.Result{}
	}
	result := r.results[0]
	if len(r.results) > 1 {
		r.results = r.results[1:]
	}
	return result
}

func (r *recordingRunner) recorded() []runCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]runCall{}, r.calls...)
}

func ok(stdout string) executable.Result {
	return executable.Result{OK: true, Stdout: stdout}
}

// useRunner replaces the package runner for this test.
func useRunner(t *testing.T, results ...executable.Result) *recordingRunner {
	runner := &recordingRunner{results: results}
	previous := runExecutable
	runExecutable = runner.run
	t.Cleanup(func() { runExecutable = previous })
	return runner
}

// useOpening replaces the ACP open for this test; every profile opens through open.
func useOpening(t *testing.T, open oar.StartSession) {
	previous := acpSession
	acpSession = func(acp.Profile) oar.StartSession { return open }
	t.Cleanup(func() { acpSession = previous })
}

func envValue(environment []string, name string) (string, bool) {
	for _, entry := range environment {
		if len(entry) > len(name) && entry[:len(name)+1] == name+"=" {
			return entry[len(name)+1:], true
		}
	}
	return "", false
}
