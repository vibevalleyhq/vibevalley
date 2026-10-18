package brain

// The agent's own task graph (internal/agent/task): it tasks the steps of one piece of work, marks them as it goes, and
// reads the whole graph back after each call. A helper's task is sent out by the runner (taskrun.go) once it is ready.

import (
	"context"
	"strings"

	"vibevalley/internal/task/engine"
	"vibevalley/pkg/agentcore"
)

// changed runs after every change the model makes, so that what became ready goes out.
func TaskTools(store engine.Store, canHelp bool, changed func()) []agentcore.AgentTool {
	answer := func(g []engine.Task, err error) (string, error) {
		if err != nil {
			return "", err
		}
		return engine.Text(g), nil
	}
	ids := map[string]any{"type": "array", "items": agentcore.StringSchema()}
	byValues := []any{string(engine.BySelf)}
	if canHelp {
		byValues = append(byValues, string(engine.ByHelper))
	}

	type added struct {
		ID    string   `json:"id"`
		Title string   `json:"title"`
		Brief string   `json:"brief"`
		After []string `json:"after"`
		By    string   `json:"by"`
	}
	type taskParams struct {
		Tasks []added `json:"tasks"`
	}
	task := TextTool(TextToolSpec[taskParams]{
		Name: "task_add",
		Description: "把一件要分几步、有先后的活写成任务：每件一个简短的英文 id、要做什么（brief：在哪、做到什么程度算完、交回什么）、要等哪几件做完（after）、谁做（by：self 你自己做；helper 交给帮手，等的做完了就自动派、几件同时做，做完把结果交回给你；帮手看不到你们的对话，brief 要写全）。" +
			"可以一次写一张图，也可以往已有的图里加；有一件不对（id 重复、等的不存在、互相等成了圈）整批都不收，回答里说哪条错。做完一件用 task_update 标上。",
		Parameters: agentcore.ObjectSchema(map[string]any{"tasks": map[string]any{"type": "array", "items": agentcore.ObjectSchema(map[string]any{
			"id": agentcore.StringSchema(), "title": agentcore.StringSchema(), "brief": agentcore.StringSchema(), "after": ids,
			"by": map[string]any{"type": "string", "enum": byValues},
		}, "id", "brief")}}, "tasks"),
		Run: func(ctx context.Context, p taskParams, _ ToolContext) (string, error) {
			more := make([]engine.Task, len(p.Tasks))
			for i, t := range p.Tasks {
				more[i] = engine.Task{ID: t.ID, Title: t.Title, Brief: t.Brief, After: t.After, By: engine.By(t.By)}
			}
			var problems []string
			g, err := store.Change(ctx, func(g []engine.Task) ([]engine.Task, error) {
				next, bad := engine.Add(g, more)
				problems = bad
				return next, nil
			})
			if err != nil {
				return "", err
			}
			if len(problems) > 0 {
				return "没收：" + strings.Join(problems, "；") + "\n\n" + engine.Text(g), nil
			}
			changed()
			return engine.Text(g), nil
		},
	})

	type updateParams struct {
		ID     string    `json:"id"`
		State  *string   `json:"state"`
		Result *string   `json:"result"`
		Brief  *string   `json:"brief"`
		After  *[]string `json:"after"`
	}
	update := TextTool(TextToolSpec[updateParams]{
		Name: "task_update",
		Description: "改一件任务：做完了 state 写 done、result 写结果（改了什么、结论、关键的数字）；做不成写 failed 和原因；不用做了写 skipped。" +
			"没做的可以改 brief 和 after；没做成的改了 brief 再把 state 写回 waiting 重来。全部做完，这张图就收起来了。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"id":     agentcore.StringSchema(),
			"state":  map[string]any{"type": "string", "enum": []any{string(engine.Done), string(engine.Failed), string(engine.Skipped), string(engine.Waiting)}},
			"result": agentcore.StringSchema(), "brief": agentcore.StringSchema(), "after": ids,
		}, "id"),
		Run: func(ctx context.Context, p updateParams, _ ToolContext) (string, error) {
			c := engine.Change{Result: p.Result, Brief: p.Brief, After: p.After}
			if p.State != nil {
				s := engine.State(*p.State)
				c.State = &s
			}
			g, err := store.Change(ctx, func(g []engine.Task) ([]engine.Task, error) { return engine.Update(g, p.ID, c) })
			if err != nil {
				return "", err
			}
			if engine.Finished(g) {
				return engine.Text(g) + "\n\n都做完了，这张图收起来了。", nil
			}
			changed()
			return engine.Text(g), nil
		},
	})

	list := TextTool(TextToolSpec[struct{}]{
		Name:        "task_graph",
		Description: "看现在的任务：每件在等、可以做、做完还是没做成，要等谁，结果的开头。",
		Parameters:  agentcore.ObjectSchema(nil),
		Run: func(ctx context.Context, _ struct{}, _ ToolContext) (string, error) {
			return answer(store.Load(ctx))
		},
	})
	return []agentcore.AgentTool{task, update, list}
}
