package tool

import (
	"context"
	"fmt"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/channel"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
)

// Talking in the channels: saying, reading, and what is unread.

// Who reads and speaks in a channel: a session as itself, the manager as the manager.
func (c Caller) participant() string {
	if c.Session != "" {
		return c.Session
	}
	return c.Agent
}

type sayArgs struct {
	Text    string `json:"text"`
	Target  string `json:"target,omitempty"`
	Anyway  bool   `json:"anyway,omitempty" jsonschema:"看过新消息、仍要原样发"`
	Confirm bool   `json:"confirm,omitempty" jsonschema:"确实要发到田头顶层，而不是刚读的那个串"`
}

func (s *Service) channelSay(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[sayArgs]{
		Name:        "channel_say",
		Description: "在农场的群聊里发一条消息。target 不填就是你自己的工单串；#<频道> 是一个频道（#" + protocol.GeneralName + " 是默认的频道田头）；#<频道>:<消息号> 是那条消息下面的串。正文里写 @w3、@管家、@主人 就是叫谁。目标里有你没看过的新消息时会先不发，把新消息给你看。",
		Parameters:  schemaOf[sayArgs](),
		Run: func(ctx context.Context, p sayArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			spoken, err := s.chat.Speak(c.participant(), p.Text, channel.SpeakOptions{Target: p.Target, Anyway: p.Anyway, Confirm: p.Confirm})
			if err != nil {
				return "", err
			}
			return spokenText(spoken), nil
		},
	})
}

func spokenText(s channel.Spoken) string {
	switch s.Kind {
	case "held":
		more := ""
		if s.More > 0 {
			more = fmt.Sprintf("（这里是最新的 %d 条）", len(s.Shown))
		}
		return strings.Join([]string{
			fmt.Sprintf("先没发：%s 里有 %d 条你还没看过的新消息%s：", s.Target, len(s.Shown)+s.More, more),
			protocol.InboxLines(s.Shown),
			"",
			"看过了：要改就改了再发；原样发就加 anyway: true；不用发了就不发。",
		}, "\n")
	case "confirm":
		return fmt.Sprintf("先没发：你刚读的是 %s，这条却要发到 %s 顶层。要回在那个串里，就把 target 写成 %s；确实要发到田头，就加 confirm: true。", s.LastRead, s.Target, s.LastRead)
	default:
		absent := ""
		if len(s.NotOnFarm) > 0 {
			names := make([]string, len(s.NotOnFarm))
			for i, m := range s.NotOnFarm {
				names[i] = "@" + m
			}
			absent = "。" + strings.Join(names, "、") + " 不在地里，没送到"
		}
		return fmt.Sprintf("发出去了：%s msg=%d%s", s.Target, s.Message.Number, absent)
	}
}

type readArgs struct {
	Target string  `json:"target,omitempty" jsonschema:"#田头、#clock-in，或 #田头:<消息号>"`
	Unread bool    `json:"unread,omitempty"`
	Before float64 `json:"before,omitempty"`
	Limit  float64 `json:"limit,omitempty"`
}

func (s *Service) readChat(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[readArgs]{
		Name: "read_chat", Label: labels["read_chat"],
		Description: "读一个频道或一个串里说的话。target 写 #<频道>（比如 #田头），或 #<频道>:<消息号>（一个串）；不填就是你正在回话的地方（帮工是自己的工单串）。unread 只读你还没读过的；before 填消息号往前翻。读过的算你看过了。",
		Parameters:  schemaOf[readArgs](),
		Run: func(ctx context.Context, p readArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			where := p.Target
			// A session's default is its own thread, which the channel service fills in.
			if where == "" && c.Session == "" {
				where = "#" + s.chat.ChannelOf(c.Here).Name
			}
			r, err := s.chat.Read(c.participant(), channel.ReadOptions{Target: where, Unread: p.Unread, Before: int64(p.Before), Limit: int64(p.Limit)})
			if err != nil {
				return "读不了：" + err.Error(), nil
			}
			if len(r.Messages) == 0 {
				if p.Unread {
					return r.Target + " 里没有你没读的消息", nil
				}
				return r.Target + " 里还没有话", nil
			}
			older := ""
			if r.Older {
				older = fmt.Sprintf("（更早的还有：before:%d 往前翻）", r.Messages[0].Number)
			}
			return r.Target + older + "：\n" + protocol.InboxLines(r.Messages), nil
		},
	})
}

func (s *Service) channelInbox(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[none]{
		Name: "channel_inbox", Description: "列出你还没读的对话：在哪、几条、有没有提到你、最后是谁说的。",
		Parameters: schemaOf[none](),
		Run: func(ctx context.Context, _ none, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			rows := s.chat.Inbox(c.participant())
			if len(rows) == 0 {
				return "没有没读的消息。", nil
			}
			lines := make([]string, 0, len(rows)+1)
			for _, r := range rows {
				line := fmt.Sprintf("- %s：%d 条", r.Target, r.Unread)
				if r.MentionsYou {
					line += "，提到了你"
				}
				if r.Latest != "" {
					line += "，最后是 " + r.Latest
				}
				lines = append(lines, line)
			}
			lines = append(lines, "下一步：read_chat target="+rows[0].Target+" unread=true")
			return strings.Join(lines, "\n"), nil
		},
	})
}
