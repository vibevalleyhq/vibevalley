package tool

import (
	"context"
	"errors"

	"vibevalley/internal/agent/brain"
	"vibevalley/pkg/agentcore"
)

// Channels: opening one, and changing what it is for.

type openArgs struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Project     string `json:"project,omitempty"`
}

func (s *Service) openChannel() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[openArgs]{
		Name: "open_channel", Label: labels["open_channel"],
		Description: "开一个新频道：一件长期的事、一个项目，单独一个地方说话、派活。name 是频道名（字母、数字、汉字、- 和 _），description 写它是做什么的，project 是它的默认项目（在这里派的活默认在这个项目里干）。主人要求了才开。",
		Parameters:  schemaOf[openArgs](),
		Run: func(_ context.Context, p openArgs, _ brain.ToolContext) (string, error) {
			c, err := s.chat.OpenChannel(p.Name, p.Description, p.Project)
			if err != nil {
				return "", err
			}
			project := ""
			if c.Project != "" {
				project = "，默认项目 " + c.Project
			}
			return "开好了 #" + c.Name + project + "。", nil
		},
	})
}

type settingsArgs struct {
	Channel     string  `json:"channel"`
	Description *string `json:"description,omitempty"`
	Project     *string `json:"project,omitempty"`
}

func (s *Service) channelSettings() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[settingsArgs]{
		Name: "channel_settings", Label: labels["channel_settings"],
		Description: "改一个频道是做什么的（description），或它的默认项目（project，写空字符串就是不要默认项目）。",
		Parameters:  schemaOf[settingsArgs](),
		Run: func(_ context.Context, p settingsArgs, _ brain.ToolContext) (string, error) {
			c := s.chat.ChannelByName(p.Channel)
			if c == nil {
				return "", errors.New("没有 " + p.Channel + " 这个频道")
			}
			if err := s.chat.UpdateChannel(c.ID, p.Description, p.Project); err != nil {
				return "", err
			}
			return "改好了 #" + c.Name + "。", nil
		},
	})
}
