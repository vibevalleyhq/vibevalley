package manager

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/agentcore"
)

func TestTheManagerSearchesAndWritesAHelpersMemory(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	lab := fixture.Lab(t)
	if _, err := f.Agent.SaveAgent(lab); err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	tools := f.Manager.tools()
	call := func(name, args string) string {
		for _, tool := range tools {
			if tool.Name == name {
				r, err := tool.Execute(context.Background(), "c1", json.RawMessage(args), nil)
				if err != nil {
					return "error: " + err.Error()
				}
				return agentcore.ResultText(r.Content)
			}
		}
		t.Fatalf("no tool %s", name)
		return ""
	}

	if added := call("memory_add", `{"agent":"`+lab.Name+`","text":"这个项目测试用 pnpm test","project":"demo"}`); !strings.Contains(added, "替 "+lab.ID+" 记下了（项目 demo）") {
		t.Fatalf("added %q", added)
	}
	if found := call("memory_search", `{"query":"测试"}`); !strings.Contains(found, lab.ID+"：（项目 demo）这个项目测试用 pnpm test") {
		t.Fatalf("every profile: %q", found)
	}
	if found := call("memory_search", `{"query":"测试","agent":"`+lab.ID+`","project":"demo"}`); !strings.Contains(found, "- （这个项目）这个项目测试用 pnpm test") {
		t.Fatalf("one profile: %q", found)
	}
	if refused := call("memory_add", `{"agent":"manager","text":"自己记"}`); !strings.Contains(refused, "remember") {
		t.Fatalf("its own memory: %q", refused)
	}
	if refused := call("memory_search", `{"agent":"nobody"}`); !strings.Contains(refused, "没有叫 nobody 的帮工档案") {
		t.Fatalf("no such profile: %q", refused)
	}
}
