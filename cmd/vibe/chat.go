package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/spf13/cobra"
)

type orchestratorChatResponse struct {
	Text    string `json:"text"`
	Content string `json:"content"`
	Reply   string `json:"reply"`
}

func newChatCommand(rt *appRuntime) *cobra.Command {
	var (
		promptFlag string
		modelFlag  string
		agentFlag  string
		cwdFlag    string
		streamFlag bool
	)

	chatCmd := &cobra.Command{
		Use:   "chat [prompt...]",
		Short: "Send a prompt to the orchestrator or OpenAI-compatible completions endpoint",
		RunE: func(cmd *cobra.Command, args []string) error {
			prompt := strings.TrimSpace(promptFlag)
			if len(args) > 0 {
				prompt = strings.TrimSpace(strings.Join(args, " "))
			}
			if prompt == "" {
				stdinText, err := rt.readAllStdin()
				if err != nil {
					return err
				}
				prompt = strings.TrimSpace(stdinText)
			}
			if prompt == "" {
				return errors.New("prompt is required")
			}

			client, _, err := rt.newClient()
			if err != nil {
				return err
			}

			model := strings.TrimSpace(modelFlag)
			if model == "" {
				model = "orchestrator"
			}

			if streamFlag {
				wroteDelta := false
				fullText, err := client.StreamChatCompletions(cmd.Context(), ChatCompletionRequest{
					Model:  model,
					Stream: true,
					Messages: []ChatCompletionMessage{
						{Role: "user", Content: prompt},
					},
				}, func(delta string) error {
					if rt.jsonOut {
						return nil
					}
					wroteDelta = true
					_, wErr := io.WriteString(rt.stdout, delta)
					return wErr
				})
				if err != nil {
					if wroteDelta {
						_, _ = io.WriteString(rt.stdout, "\n")
					}
					return err
				}
				if rt.jsonOut {
					return rt.writeJSON(map[string]any{
						"model":    model,
						"content":  fullText,
						"streamed": true,
					})
				}
				if wroteDelta {
					if !strings.HasSuffix(fullText, "\n") {
						_, err = io.WriteString(rt.stdout, "\n")
						return err
					}
					return nil
				}
				return rt.writeOutput(nil, func() string { return fullText })
			}

			// Non-streaming path: try orchestrator RPC first, falling back to /v1/chat/completions on 404.
			rpcReq := map[string]any{
				"text":   prompt,
				"prompt": prompt,
			}
			if modelFlag != "" {
				rpcReq["model"] = model
			}
			if agentFlag != "" {
				rpcReq["agent"] = agentFlag
			}
			if cwdFlag != "" {
				rpcReq["cwd"] = cwdFlag
			}

			raw, err := client.CallRaw(cmd.Context(), "orchestrator.send", rpcReq)
			if err == nil {
				var rpcResp orchestratorChatResponse
				if len(bytes.TrimSpace(raw)) > 0 {
					_ = json.Unmarshal(raw, &rpcResp)
				}
				reply := rpcResp.Content
				if reply == "" {
					reply = rpcResp.Text
				}
				if reply == "" {
					reply = rpcResp.Reply
				}
				return rt.writeOutput(
					rawOrValue(raw, map[string]any{"model": model, "content": reply}),
					func() string { return reply },
				)
			}

			var apiErr *APIError
			if !errors.As(err, &apiErr) || !apiErr.isNotFound() {
				return err
			}

			text, rawComp, compErr := client.ChatCompletions(cmd.Context(), ChatCompletionRequest{
				Model:  model,
				Stream: false,
				Messages: []ChatCompletionMessage{
					{Role: "user", Content: prompt},
				},
			})
			if compErr != nil {
				return compErr
			}
			return rt.writeOutput(
				rawOrValue(rawComp, map[string]any{"model": model, "content": text}),
				func() string { return text },
			)
		},
	}

	chatCmd.Flags().StringVarP(&promptFlag, "prompt", "p", "", "prompt text (alternative to positional arguments)")
	chatCmd.Flags().StringVar(&modelFlag, "model", "", "model or orchestrator target")
	chatCmd.Flags().StringVar(&agentFlag, "agent", "", "orchestrator profile name")
	chatCmd.Flags().StringVar(&cwdFlag, "cwd", "", "working directory context")
	chatCmd.Flags().BoolVar(&streamFlag, "stream", false, "stream SSE deltas via /v1/chat/completions")
	return chatCmd
}
