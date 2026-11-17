package main

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type channelView struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Title   string `json:"title"`
	Default bool   `json:"default"`
	Unread  int    `json:"unread"`
}

type channelMessageView struct {
	ID       string `json:"id"`
	Number   int    `json:"number"`
	Seq      int64  `json:"seq"`
	Name     string `json:"name"`
	AuthorID string `json:"authorId"`
	From     string `json:"from"`
	Text     string `json:"text"`
}

func formatChannelLine(c channelView) string {
	name := strings.TrimSpace(c.Name)
	if name == "" {
		name = strings.TrimSpace(c.Title)
	}
	if name == "" {
		name = c.ID
	}
	parts := []string{"#" + name}
	if c.Type != "" {
		parts = append(parts, c.Type)
	}
	if c.Default {
		parts = append(parts, "default")
	}
	if c.Unread > 0 {
		parts = append(parts, fmt.Sprintf("unread %d", c.Unread))
	}
	return strings.Join(parts, "  ")
}

func formatChannelMessageLine(m channelMessageView) string {
	num := int64(m.Number)
	if num == 0 {
		num = m.Seq
	}
	who := strings.TrimSpace(m.Name)
	if who == "" {
		who = strings.TrimSpace(m.AuthorID)
	}
	if who == "" {
		who = strings.TrimSpace(m.From)
	}
	if who == "" {
		who = "unknown"
	}
	text := strings.Join(strings.Fields(m.Text), " ")
	return fmt.Sprintf("#%d  %s: %s", num, who, text)
}

func newChannelCommand(rt *appRuntime) *cobra.Command {
	channelCmd := &cobra.Command{
		Use:   "channel",
		Short: "List and interact with channels",
	}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List channels",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var channels []channelView
			raw, err := client.Call(cmd.Context(), "channel.list", nil, &channels)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, channels), func() string {
				if len(channels) == 0 {
					return "no channels"
				}
				lines := make([]string, 0, len(channels))
				for _, ch := range channels {
					lines = append(lines, formatChannelLine(ch))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	var (
		msgLimit  int
		msgBefore int
	)
	messagesCmd := &cobra.Command{
		Use:     "messages <id>",
		Aliases: []string{"history"},
		Short:   "List messages in a channel",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{"id": args[0]}
			if msgLimit > 0 {
				req["limit"] = msgLimit
			}
			if cmd.Flags().Changed("before") {
				req["before"] = msgBefore
			}
			var msgs []channelMessageView
			raw, err := client.CallWithFallback(cmd.Context(), "channel.message.list", "channel.messages", req, req, &msgs)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, msgs), func() string {
				if len(msgs) == 0 {
					return "no messages"
				}
				lines := make([]string, 0, len(msgs))
				for _, m := range msgs {
					lines = append(lines, formatChannelMessageLine(m))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	messagesCmd.Flags().IntVar(&msgLimit, "limit", 20, "maximum number of messages to fetch")
	messagesCmd.Flags().IntVar(&msgBefore, "before", 0, "fetch messages before message number")

	var (
		sendReply int
		sendAgent string
		sendRepo  string
		sendKey   string
	)
	sendCmd := &cobra.Command{
		Use:   "send <id> <text...>",
		Short: "Send a message to a channel",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			channelID := args[0]
			text := strings.Join(args[1:], " ")
			req := map[string]any{
				"id":   channelID,
				"text": text,
			}
			if cmd.Flags().Changed("reply") {
				req["replyTo"] = sendReply
			}
			if sendAgent != "" {
				req["agent"] = sendAgent
			}
			if sendRepo != "" {
				req["repo"] = sendRepo
			}
			if sendKey != "" {
				req["sendKey"] = sendKey
			}
			raw, err := client.CallWithFallback(cmd.Context(), "channel.message.send", "channel.send", req, req, nil)
			if err != nil {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"sent": true, "channel": channelID, "text": text}),
				func() string { return fmt.Sprintf("sent to #%s", channelID) },
			)
		},
	}
	sendCmd.Flags().IntVar(&sendReply, "reply", 0, "message number to reply to")
	sendCmd.Flags().StringVar(&sendAgent, "agent", "", "agent profile hint")
	sendCmd.Flags().StringVar(&sendRepo, "repo", "", "repository hint")
	sendCmd.Flags().StringVar(&sendKey, "key", "", "idempotency sendKey")

	channelCmd.AddCommand(listCmd, messagesCmd, sendCmd)
	return channelCmd
}
