package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// runtimeChat is `vibevalley runtime chat <runtime>`: a conversation with one runtime through smith, on this machine. It
// is not farm work: no issue, any folder, nothing in the core state, the trajectories or the farm's spending.
func runtimeChat(ctx context.Context, raw []string) error {
	if len(raw) == 0 {
		return errors.New("要哪个农机：vibevalley runtime chat <runtime>（claude、codex、kimi、pi……；vibevalley 是自己的 agent）")
	}
	id := raw[0]
	if id == "vibevalley" {
		return ownChat(raw[1:])
	}
	fs := flag.NewFlagSet("runtime chat", flag.ContinueOnError)
	model := fs.String("model", "", "模型（默认农机自己的）")
	effort := fs.String("effort", "", "思考的力度")
	resume := fs.String("resume", "", "接着一个 oar 会话")
	cwdFlag := fs.String("cwd", "", "它干活的目录（默认当前目录）")
	once := fs.String("p", "", "问这一句就走")
	if err := fs.Parse(raw[1:]); err != nil {
		return err
	}
	registry, err := runtimes()
	if err != nil {
		return err
	}
	runtime, err := registry.Require(id)
	if err != nil {
		return err
	}
	if runtime.Installation == nil {
		return fmt.Errorf("%s 看不出装没装", id)
	}
	installation, err := runtime.Installation(ctx, oar.InstallationOptions{})
	if err != nil {
		return err
	}
	if installation.Kind != "available" {
		return fmt.Errorf("%s 用不了：%s", id, installation.Kind)
	}
	cwd, _ := os.Getwd()
	if *cwdFlag != "" {
		cwd, _ = filepath.Abs(*cwdFlag)
	}
	session, err := runtime.Session(ctx, installation.Available, oar.SessionOptions{Cwd: cwd, Model: *model, Effort: *effort, Resume: *resume})
	if err != nil {
		return fmt.Errorf("%s 的会话没开起来：%w", id, err)
	}
	defer session.Dispose(context.Background())

	var out sync.Mutex
	say := func(lines ...string) {
		out.Lock()
		defer out.Unlock()
		for _, l := range lines {
			fmt.Println(l)
		}
	}
	say(observe.RenderOpened(observe.OpenedSession{SessionID: session.ID(), Resumed: *resume != "", Model: session.Model().Value, Effort: session.Effort().Value, ServiceTier: session.ServiceTier().Value}),
		dim("直接聊：不经过农场，不记轨迹和花费。Ctrl+C 停这一轮，空着时再按退出。"))
	render := observe.ProgressRenderer(id)
	session.Events(func(e oar.Event) { say(render(e)...) }, oar.EventsOptions{Cursor: &oar.Cursor{SessionID: session.ID(), AfterSeq: -1}, CoalesceText: true, MaxHoldMs: 250})

	// One turn at a time: a line typed while it runs is steered into it or queued after it.
	done := make(chan observe.PromptRun, 1)
	var cancel func()
	turn := func(text string) {
		c := make(chan struct{})
		cancel = sync.OnceFunc(func() { close(c) })
		go func() {
			run, err := observe.PromptAndWait(ctx, session, text, observe.PromptRunOptions{Cancel: c})
			if err != nil {
				run = observe.PromptRun{Kind: "rejected", Reason: err.Error()}
			}
			done <- run
		}()
	}
	ended := func(run observe.PromptRun) {
		if run.Kind == "rejected" {
			say(dim(fmt.Sprintf("没接住（%s）：%s", run.Code, run.Reason)))
		}
	}
	if *once != "" {
		turn(*once)
		ended(<-done)
		return nil
	}

	fmt.Print("› ")
	input := openTerminal(ctx, os.Stdin)
	defer input.close()
	busy := false
	for {
		select {
		case run := <-done:
			busy = false
			ended(run)
			fmt.Print("› ")
		case event, ok := <-input.events:
			if !ok {
				return nil
			}
			if event.err != nil {
				return event.err
			}
			if event.interrupt {
				if !busy {
					fmt.Println()
					return nil
				}
				cancel()
				continue
			}
			text := event.text
			switch {
			case text == "/exit":
				return nil
			case text == "":
				if !busy {
					fmt.Print("› ")
				}
			case busy:
				if r, err := session.SteerOrQueue(ctx, text, oar.InputOptions{}); err != nil || r.Landed == "" {
					say(dim(fmt.Sprintf("没送进去：%v %s", err, r.Reason)))
				}
			default:
				busy = true
				turn(text)
			}
		}
	}
}
