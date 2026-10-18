package brain

// They touch only the agent's own folder.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"vibevalley/pkg/agentcore"
)

type SelfOptions struct {
	Home string
	// Scanned each time it asks.
	Skills func() []SkillInfo
	Memory bool
}

func SelfTools(o SelfOptions) []agentcore.AgentTool {
	loadSkill := TextTool(TextToolSpec[struct {
		Name string `json:"name"`
	}]{
		Name:        "load_skill",
		Description: "读一个技能的全文（系统提示里「技能」列着有哪些）。要用某个技能之前先读它，再照着做。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"name": agentcore.StringSchema()}, "name"),
		Run: func(_ context.Context, p struct {
			Name string `json:"name"`
		}, _ ToolContext) (string, error) {
			return ReadSkill(o.Skills(), p.Name)
		},
	})

	remember := TextTool(TextToolSpec[struct {
		Note string `json:"note"`
	}]{
		Name:        "remember",
		Description: "记下一条以后的对话也要知道的事：用户的偏好、约定、项目的关键事实。一句话，不记临时的事。记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"note": agentcore.StringSchema()}, "note"),
		Run: func(_ context.Context, p struct {
			Note string `json:"note"`
		}, _ ToolContext) (string, error) {
			if strings.TrimSpace(p.Note) == "" {
				return "", errors.New("note 是空的。")
			}
			if _, err := Remember(o.Home, p.Note, time.Now()); err != nil {
				return "", err
			}
			return "记下了。", nil
		},
	})

	rewrite := TextTool(TextToolSpec[struct {
		Content string `json:"content"`
	}]{
		Name:        "rewrite_memory",
		Description: "整个重写你的记性（MEMORY.md）：合并重复的、删掉过时或错的。先看系统提示里的「记性」，再给出完整的新内容。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"content": agentcore.StringSchema()}, "content"),
		Run: func(_ context.Context, p struct {
			Content string `json:"content"`
		}, _ ToolContext) (string, error) {
			written, err := RewriteMemory(o.Home, p.Content)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("重写好了，现在 %d 行。", written.LineCount), nil
		},
	})

	search := TextTool(TextToolSpec[struct {
		Query string `json:"query"`
	}]{
		Name:        "search_archive",
		Description: "在压缩掉的旧对话原文里搜一个词（不分大小写），返回出现的地方和前后几行。摘要里缺了细节时用。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"query": agentcore.StringSchema()}, "query"),
		Run: func(_ context.Context, p struct {
			Query string `json:"query"`
		}, _ ToolContext) (string, error) {
			return SearchIn(o.Home, p.Query)
		},
	})

	tools := []agentcore.AgentTool{loadSkill}
	if o.Memory {
		tools = append(tools, remember, rewrite)
	}
	return append(tools, search)
}

func SearchIn(home, query string) (string, error) {
	if strings.TrimSpace(query) == "" {
		return "", errors.New("query 是空的。")
	}
	if len(ArchiveFiles(home)) == 0 {
		return "还没有归档的旧对话。", nil
	}
	hits := SearchArchive(home, query, 0)
	if len(hits) == 0 {
		return "旧对话里没有「" + query + "」。", nil
	}
	parts := make([]string, 0, len(hits))
	for _, h := range hits {
		parts = append(parts, fmt.Sprintf("%s:%d\n%s", h.File, h.Line, h.Text))
	}
	return strings.Join(parts, "\n\n---\n\n"), nil
}
