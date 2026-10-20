package tool

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
)

// Documents: a session reads one, appends blocks and rewrites a block's text against the rev it read, through the same op
// pipeline the owner's editor uses, written as its profile (its session id when it has none).

func writer(c Caller) string {
	if c.Agent != "" {
		return c.Agent
	}
	return c.Session
}

var appendTypes = []string{protocol.BlockParagraph, protocol.BlockHeading, protocol.BlockBulleted, protocol.BlockNumbered, protocol.BlockTodo, protocol.BlockQuote, protocol.BlockCode}

type docReadArgs struct {
	Doc string `json:"doc" jsonschema:"文档的 id"`
}

type docAppendArgs struct {
	Doc   string `json:"doc" jsonschema:"文档的 id"`
	Text  string `json:"text" jsonschema:"这一块的字；可以用 **粗**、_斜_、行内代码、~~删~~ 和链接；代码块照原样存"`
	Type  string `json:"type,omitempty" jsonschema:"块的类型：paragraph（默认）、heading、bulleted、numbered、todo、quote、code"`
	Level int64  `json:"level,omitempty" jsonschema:"标题的级别 1–3，只给 heading 用；默认 2"`
}

type docUpdateArgs struct {
	Doc     string `json:"doc" jsonschema:"文档的 id"`
	Block   string `json:"block" jsonschema:"块的 id"`
	BaseRev int64  `json:"base_rev" jsonschema:"你读到或写下这一块时它是第几版"`
	Text    string `json:"text" jsonschema:"这一块完整的新字，不是增量"`
}

func blockLine(b protocol.Block) string {
	var text strings.Builder
	for _, s := range b.Text {
		text.WriteString(s.T)
	}
	return fmt.Sprintf("- 〔%s · 第 %d 版 · %s〕%s", b.ID, b.Rev, b.Type, text.String())
}

func (s *Service) docRead(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[docReadArgs]{
		Name: "doc_read", Label: labels["doc_read"],
		Description: "读一篇文档：每一块的 id、第几版、类型和字。改一块之前先读，doc_update 要用这里的 id 和版本。",
		Parameters:  schemaOf[docReadArgs](),
		Run: func(ctx context.Context, p docReadArgs, _ brain.ToolContext) (string, error) {
			if _, err := who(ctx); err != nil {
				return "", err
			}
			snap, err := s.docs.Get(ctx, strings.TrimSpace(p.Doc))
			if err != nil {
				return "", err
			}
			lines := []string{"《" + snap.Doc.Title + "》，" + fmt.Sprint(len(snap.Blocks)) + " 块："}
			for _, b := range snap.Blocks {
				lines = append(lines, blockLine(b))
			}
			return strings.Join(lines, "\n"), nil
		},
	})
}

func (s *Service) docAppend(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[docAppendArgs]{
		Name: "doc_append", Label: labels["doc_append"],
		Description: "在文档末尾加一块。写长的东西时一段一块，不要把整篇塞进一块；写一块要接着改，就用回答里的 id 和版本调 doc_update。",
		Parameters:  schemaOf[docAppendArgs](),
		Run: func(ctx context.Context, p docAppendArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			typ := strings.TrimSpace(p.Type)
			if typ == "" {
				typ = protocol.BlockParagraph
			}
			if !slices.Contains(appendTypes, typ) {
				return "", errors.New("块的类型只能是 " + strings.Join(appendTypes, "、"))
			}
			var attrs protocol.BlockAttrs
			switch typ {
			case protocol.BlockHeading:
				level := p.Level
				if level < 1 || level > 3 {
					level = 2
				}
				attrs.Level = &level
			case protocol.BlockTodo:
				attrs.Checked = new(false)
			}
			b, r, err := s.docs.Append(ctx, strings.TrimSpace(p.Doc), writer(c), typ, attrs, p.Text)
			if err != nil {
				return "", err
			}
			if r.Status != protocol.DocOpStatusApplied {
				return "", errors.New(r.Reason)
			}
			return fmt.Sprintf("加了一块〔%s〕，第 %d 版。接着改它用 doc_update，block 填 %s，base_rev 填 %d。", b.ID, b.Rev, b.ID, b.Rev), nil
		},
	})
}

func (s *Service) docUpdate(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[docUpdateArgs]{
		Name: "doc_update", Label: labels["doc_update"],
		Description: "把一块的字整段换成新的。base_rev 是你读到或写下它时的版本：这之后别人改过它的字，就不改，回答里有现在的字和版本，看过再决定要不要照着重写。",
		Parameters:  schemaOf[docUpdateArgs](),
		Run: func(ctx context.Context, p docUpdateArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			_, r, err := s.docs.UpdateText(ctx, strings.TrimSpace(p.Doc), writer(c), strings.TrimSpace(p.Block), p.BaseRev, p.Text)
			if err != nil {
				return "", err
			}
			switch r.Status {
			case protocol.DocOpStatusApplied:
				return fmt.Sprintf("改好了〔%s〕，现在是第 %d 版。", r.BlockID, r.Rev), nil
			case protocol.DocOpStatusConflict:
				now, err := s.docs.Get(ctx, strings.TrimSpace(p.Doc))
				current := ""
				if err == nil {
					for _, x := range now.Blocks {
						if x.ID == r.BlockID {
							current = "\n现在的字：" + blockLine(x)
						}
					}
				}
				return fmt.Sprintf("没改：%s，现在是第 %d 版。%s", r.Reason, r.Rev, current), nil
			}
			return "", errors.New(r.Reason)
		},
	})
}
