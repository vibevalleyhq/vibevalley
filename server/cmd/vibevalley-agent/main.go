// The agent on its own, in a terminal: a conversation on DeepSeek with the coding tools, skills, memory, helpers,
// schedules and the MCP servers in a config file. What is typed while it works joins the turn; Ctrl+C stops the
// turn, and again (idle) quits.
//
//	go run ./cmd/vibevalley-agent [--cwd DIR] [--name NAME] [--model ID] [--mcp FILE] [-p PROMPT]
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"

	"vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const INSTRUCTIONS = `你是 VibeValley，一个在用户电脑上干活的助手：读写代码、跑命令、查资料、记住用户交代的事、按时做定好的事。
- 先弄清楚再动手：读相关的文件，看清现状；改完跑能跑的检查（lint、类型检查、测试）确认。
- 能自己查到的不问；真正要用户拿主意的才问，一次问清。
- 几件互不相干、各自要花工夫的事，用 spawn_agent 派帮手同时做。
- 用户说「记住」「以后都」时用 remember；说「每天」「到点」「过一会儿」时用 schedule。
- 回答用中文，简短，先说结论。`

func dim(s string) string { return "\x1b[2m" + s + "\x1b[0m" }

func short(s string) string {
	r := []rune(s)
	if len(r) > 120 {
		s = string(r[:120]) + "…"
	}
	return strings.Join(strings.Fields(s), " ")
}

type spent struct{ input, cached, output int }

func show(e agent.AgentEvent, total *spent, prompt func()) {
	switch e.Type {
	case agentcore.EventMessageUpdate:
		d := e.AssistantMessageEvent
		switch d.Type {
		case ai.EventThinkingDelta:
			fmt.Print(dim(d.Delta))
		case ai.EventThinkingEnd:
			fmt.Print("\n")
		case ai.EventTextDelta:
			fmt.Print(d.Delta)
		}
	case agentcore.EventMessageEnd:
		m, ok := e.Message.(ai.AssistantMessage)
		if !ok {
			return
		}
		total.input += m.Usage.Input
		total.cached += m.Usage.CacheRead
		total.output += m.Usage.Output
		if m.StopReason == ai.StopError {
			fmt.Print("\n出错了：" + m.ErrorMessage)
		}
		fmt.Print("\n")
	case agentcore.EventToolExecutionStart:
		fmt.Println(dim("→ " + e.ToolName + " " + short(string(e.Args))))
	case agentcore.EventToolExecutionEnd:
		mark := "✓"
		if e.IsError {
			mark = "✗"
		}
		fmt.Println(dim(mark + " " + short(agentcore.ResultText(e.Result.Content))))
	case agent.EventCompactionEnd:
		if e.Compaction != nil {
			fmt.Println(dim("（前面的对话压成了摘要，原文在 " + e.Compaction.Archive + "）"))
		}
	case agent.EventAgentSettled:
		stopped := ""
		if e.Aborted {
			stopped = "停下了，"
		}
		fmt.Print(dim(fmt.Sprintf("（%s输入 %d，缓存 %d，输出 %d）\n", stopped, total.input, total.cached, total.output)))
		*total = spent{}
		if prompt != nil {
			prompt()
		}
	}
}

func main() {
	cwdFlag := flag.String("cwd", "", "它读写文件、跑命令的地方（默认当前目录）")
	name := flag.String("name", "vibevalley", "它自己的目录是 ~/.vibevalley/agent/<name>/")
	model := flag.String("model", "", "模型（默认 VIBEVALLEY_AGENT_MODEL，再是 deepseek-flash）")
	mcpFile := flag.String("mcp", "", "MCP 配置（默认 ~/.vibevalley/agent/<name>/mcp.json）")
	once := flag.String("p", "", "问这一句就走")
	flag.Parse()
	asked := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "p" {
			asked = true
		}
	})
	if err := run(*cwdFlag, *name, *model, *mcpFile, *once, asked); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func run(cwdFlag, name, model, mcpFile, once string, asked bool) error {
	llm, err := agent.Deepseek(model, "")
	if err != nil {
		return err
	}
	cwd, _ := os.Getwd()
	if cwdFlag != "" {
		cwd, _ = filepath.Abs(cwdFlag)
	}
	userHome, _ := os.UserHomeDir()
	home := filepath.Join(userHome, ".vibevalley", "agent", name)
	if mcpFile == "" {
		mcpFile = filepath.Join(home, "mcp.json")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	servers, err := agent.ReadMcpConfig(mcpFile)
	if err != nil {
		return err
	}
	mcp := agent.ConnectAll(ctx, servers)
	defer mcp.Close()
	for _, why := range mcp.Failed {
		fmt.Fprintln(os.Stderr, dim(why))
	}
	// A one-off question keeps no schedules running.
	schedules := !asked
	a := agent.NewAgent(ctx, agent.AgentOptions{
		Name:          name,
		Instructions:  INSTRUCTIONS,
		Model:         llm.Model,
		StreamOptions: llm.StreamOptions,
		Home:          home,
		Cwd:           cwd,
		Tools:         append(agent.CodingTools(agent.CodingOptions{Cwd: cwd}), mcp.Tools...),
		Schedules:     &schedules,
	})
	defer a.Close()

	var mu sync.Mutex
	prompt := func() {}
	events := a.Subscribe()
	defer events.Close()
	go func() {
		total := &spent{}
		for e := range events.C {
			mu.Lock()
			p := prompt
			mu.Unlock()
			show(e, total, p)
		}
	}()

	if asked {
		printed := make(chan struct{}, 1)
		mu.Lock()
		prompt = func() { printed <- struct{}{} }
		mu.Unlock()
		if _, err := a.Ask(ctx, agent.UserMessage(once)); err != nil {
			return err
		}
		<-printed
		return nil
	}

	fmt.Println(dim(fmt.Sprintf("vibevalley agent · %s · %s\n%d 个技能，%d 个 MCP 工具。/reset 忘掉对话，/exit 退出，Ctrl+C 停下。", cwd, home, len(a.Skills()), len(mcp.Tools))))
	mu.Lock()
	prompt = func() { fmt.Print("› ") }
	mu.Unlock()
	fmt.Print("› ")

	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	for {
		select {
		case <-interrupts:
			if !a.Busy() {
				fmt.Println()
				return nil
			}
			a.Stop()
		case line, ok := <-lines:
			if !ok {
				return nil
			}
			text := strings.TrimSpace(line)
			switch {
			case text == "/exit":
				return nil
			case text == "/reset":
				_ = a.Reset()
				fmt.Println(dim("忘掉了。"))
				fmt.Print("› ")
			case text != "":
				a.Send(agent.UserMessage(text))
			default:
				fmt.Print("› ")
			}
		}
	}
}
