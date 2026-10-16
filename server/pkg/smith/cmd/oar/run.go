package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/voyage"
)

// run is `oar run`: one turn in a fresh (or resumed) session, its progress shown live.
func (c *cli) run(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, []string{"model", "effort", "service-tier", "resume", "record", "image"}, []string{"json"})
	if err != nil {
		return err
	}
	id, ok1 := parsed.arg(0)
	prompt, ok2 := parsed.arg(1)
	if !ok1 || !ok2 {
		return fmt.Errorf("missing required argument: oar run <runtime> <prompt>")
	}
	runtime, err := c.registry.Require(id)
	if err != nil {
		return err
	}
	if runtime.Installation == nil {
		fmt.Fprintf(c.stderr, "%s has no installation capability\n", id)
		c.exitCode = 1
		return nil
	}
	installation, err := runtime.Installation(ctx)
	if err != nil {
		return err
	}
	if installation.Kind != "available" {
		fmt.Fprintf(c.stderr, "%s is not available: %s\n", id, installation.Kind)
		c.exitCode = 1
		return nil
	}
	cwd, _ := os.Getwd()
	options := oar.SessionOptions{Cwd: cwd}
	options.Model, _ = parsed.value("model")
	options.Effort, _ = parsed.value("effort")
	options.ServiceTier, _ = parsed.value("service-tier")
	options.Resume, _ = parsed.value("resume")
	// A refused open is the runtime's answer, not a crash.
	session, err := runtime.Session(ctx, installation.Available, options)
	if err != nil {
		fmt.Fprintf(c.stderr, "%s session did not open: %s\n", id, err)
		c.exitCode = 1
		return nil
	}
	var recorder *voyage.Recorder
	if file, ok := parsed.value("record"); ok {
		recorder, err = voyage.Open(file, voyage.Header{Runtime: id, Model: options.Model, Effort: options.Effort, ServiceTier: options.ServiceTier, Cwd: cwd, SessionID: session.ID(), StartedAt: time.Now().UnixMilli(), Recorder: "oar-cli/" + version})
		if err != nil {
			_ = session.Dispose(context.Background())
			return err
		}
	}
	json := parsed.flag("json")
	var outMu sync.Mutex
	// Replay from the start so the log and output carry the records stamped while opening.
	cursor := &oar.Cursor{SessionID: session.ID(), AfterSeq: -1}
	recordsDone := make(chan struct{})
	total := 0
	session.RawEvents(func(record oar.RawEvent) {
		if recorder != nil {
			_ = recorder.Record(record)
		}
		if json {
			outMu.Lock()
			fmt.Fprintln(c.stdout, compact(record))
			outMu.Unlock()
		}
		outMu.Lock()
		total++
		outMu.Unlock()
	}, cursor)
	if !json {
		fmt.Fprintln(c.stdout, renderOpened(openedSession{sessionID: session.ID(), resumed: options.Resume != "", model: session.Model().Value, effort: session.Effort().Value, serviceTier: session.ServiceTier().Value}))
		render := progressRenderer(id)
		session.Events(func(event oar.Event) {
			lines := render(event)
			outMu.Lock()
			defer outMu.Unlock()
			for _, line := range lines {
				fmt.Fprintln(c.stdout, line)
			}
		}, oar.EventsOptions{Cursor: cursor, CoalesceText: true, MaxHoldMs: 250})
	}
	// The runtime leads its own process group, so Ctrl-C reaches this
	// process only: the first interrupts the turn, a later one disposes.
	interrupts := make(chan os.Signal, 2)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	cancel := make(chan struct{})
	var disposeOnce sync.Once
	dispose := func() { disposeOnce.Do(func() { _ = session.Dispose(context.Background()) }) }
	go func() {
		first := true
		for range interrupts {
			if first {
				first = false
				close(cancel)
			} else {
				go dispose()
			}
		}
	}()
	var images []oar.InputImage
	for _, file := range parsed.values["image"] {
		absolute, _ := filepath.Abs(file)
		images = append(images, oar.InputImage{Path: absolute})
	}
	run, err := observe.PromptAndWait(ctx, session, prompt, observe.PromptRunOptions{Cancel: cancel, Images: images})
	dispose()
	close(recordsDone)
	// Let the delivery goroutines print what the dispose recorded.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		outMu.Lock()
		caughtUp := total >= len(session.Records())
		outMu.Unlock()
		if caughtUp {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond) // the coalesced text's hold
	if recorder != nil {
		_ = recorder.End("disposed")
	}
	if err != nil {
		return err
	}
	if run.Kind == "rejected" {
		fmt.Fprintf(c.stderr, "prompt not accepted (%s): %s\n", run.Code, run.Reason)
		c.exitCode = 1
		return nil
	}
	if json {
		outMu.Lock()
		fmt.Fprintln(c.stdout, compact(map[string]any{"outcome": run.Outcome}))
		outMu.Unlock()
	}
	if run.Kind == "interrupted" && run.By == "signal" {
		c.exitCode = 130
		return nil
	}
	if run.Outcome.Kind != "completed" {
		c.exitCode = 1
	}
	return nil
}
