package replaytest

import (
	"encoding/json"
	"strings"
	"sync"
)

// ClaudeFixtureConfig configures a simulated Claude Code stream-json CLI for offline replay tests.
type ClaudeFixtureConfig struct {
	SessionID        string
	Model            string
	BaselineUsage    map[string]any
	TimeoutGetUsage  bool
	FailGetUsage     bool
	TurnResultUsage  map[string]any
	TurnFlatUsage    map[string]any
	TurnTotalCostUSD *float64
	EmitSubagent     bool
	NestedSubagent   bool
	IncludePartial   bool
	ContextWindow    int64
}

// ClaudeFixtureHandler builds a stateful StdinHandler simulating Claude Code bidirectional stream-json.
func ClaudeFixtureHandler(cfg ClaudeFixtureConfig) StdinHandler {
	if cfg.SessionID == "" {
		cfg.SessionID = "claude-sess-1"
	}
	if cfg.Model == "" {
		cfg.Model = "claude-sonnet-4-5"
	}
	var mu sync.Mutex
	inited := false

	return func(p *ScriptedProcess, line []byte) {
		var msg struct {
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype string `json:"subtype"`
				TaskID  string `json:"task_id"`
			} `json:"request"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &msg) != nil {
			return
		}

		mu.Lock()
		emitInit := !inited
		if emitInit {
			inited = true
		}
		mu.Unlock()

		if emitInit {
			p.EmitJSON(map[string]any{
				"type":       "system",
				"subtype":    "init",
				"session_id": cfg.SessionID,
				"model":      cfg.Model,
			})
		}

		switch msg.Type {
		case "control_request":
			switch msg.Request.Subtype {
			case "get_usage":
				if cfg.TimeoutGetUsage {
					return
				}
				if cfg.FailGetUsage {
					p.EmitJSON(map[string]any{
						"type": "control_response",
						"response": map[string]any{
							"subtype":    "error",
							"request_id": msg.RequestID,
							"error":      "usage unavailable",
						},
					})
					return
				}
				p.EmitJSON(map[string]any{
					"type": "control_response",
					"response": map[string]any{
						"subtype":    "success",
						"request_id": msg.RequestID,
						"response": map[string]any{
							"model_usage": cfg.BaselineUsage,
						},
					},
				})
			case "interrupt":
				p.EmitJSON(map[string]any{
					"type": "control_response",
					"response": map[string]any{
						"subtype":    "success",
						"request_id": msg.RequestID,
					},
				})
				p.EmitJSON(map[string]any{
					"type":       "result",
					"subtype":    "aborted",
					"is_error":   false,
					"session_id": cfg.SessionID,
				})
			case "stop_task":
				p.EmitJSON(map[string]any{
					"type": "control_response",
					"response": map[string]any{
						"subtype":    "success",
						"request_id": msg.RequestID,
					},
				})
				p.EmitJSON(map[string]any{
					"type":       "system",
					"subtype":    "task_notification",
					"task_id":    msg.Request.TaskID,
					"status":     "killed",
					"summary":    "stopped by host",
					"session_id": cfg.SessionID,
				})
			default:
				p.EmitJSON(map[string]any{
					"type": "control_response",
					"response": map[string]any{
						"subtype":    "success",
						"request_id": msg.RequestID,
					},
				})
			}

		case "user":
			content := msg.Message.Content
			if content == "/compact" {
				p.EmitJSON(map[string]any{
					"type":       "system",
					"subtype":    "status",
					"status":     "compacting",
					"session_id": cfg.SessionID,
				})
				p.EmitJSON(map[string]any{
					"type":       "system",
					"subtype":    "compact_boundary",
					"session_id": cfg.SessionID,
				})
				p.EmitJSON(map[string]any{
					"type":       "result",
					"subtype":    "success",
					"is_error":   false,
					"session_id": cfg.SessionID,
					"modelUsage": cfg.TurnResultUsage,
					"usage":      cfg.TurnFlatUsage,
				})
				return
			}

			if strings.Contains(content, "abort_wait") {
				p.EmitJSON(map[string]any{
					"type":       "assistant",
					"session_id": cfg.SessionID,
					"message": map[string]any{
						"id":      "msg-wait",
						"content": []map[string]any{{"type": "text", "text": "working..."}},
					},
				})
				return
			}

			if cfg.IncludePartial {
				p.EmitJSON(map[string]any{
					"type":       "stream_event",
					"session_id": cfg.SessionID,
					"event": map[string]any{
						"type":    "message_start",
						"message": map[string]any{"id": "msg-1"},
					},
				})
				p.EmitJSON(map[string]any{
					"type":       "stream_event",
					"session_id": cfg.SessionID,
					"event": map[string]any{
						"type":  "content_block_delta",
						"index": 0,
						"delta": map[string]any{"type": "text_delta", "text": "Hello "},
					},
				})
			}

			p.EmitJSON(map[string]any{
				"type":       "assistant",
				"session_id": cfg.SessionID,
				"message": map[string]any{
					"id":    "msg-1",
					"model": cfg.Model,
					"usage": map[string]any{"input_tokens": 100, "output_tokens": 20},
					"content": []map[string]any{
						{"type": "text", "text": "Hello world"},
					},
				},
			})

			if cfg.EmitSubagent {
				p.EmitJSON(map[string]any{
					"type":        "system",
					"subtype":     "task_started",
					"task_id":     "task-sub-1",
					"task_type":   "local_agent",
					"description": "inspect files",
					"session_id":  cfg.SessionID,
				})
				p.EmitJSON(map[string]any{
					"type":       "assistant",
					"session_id": cfg.SessionID,
					"message": map[string]any{
						"id": "msg-parent-tool",
						"content": []map[string]any{
							{"type": "tool_use", "id": "toolu_sub1", "name": "Task", "input": map[string]any{"prompt": "scan"}},
						},
					},
				})
				p.EmitJSON(map[string]any{
					"type":               "assistant",
					"session_id":         cfg.SessionID,
					"parent_tool_use_id": "toolu_sub1",
					"message": map[string]any{
						"id": "msg-sub-1",
						"content": []map[string]any{
							{"type": "text", "text": "subagent reading"},
							{"type": "tool_use", "id": "toolu_nested2", "name": "Read", "input": map[string]any{"path": "a.go"}},
						},
					},
				})
				if cfg.NestedSubagent {
					p.EmitJSON(map[string]any{
						"type":               "assistant",
						"session_id":         cfg.SessionID,
						"parent_tool_use_id": "toolu_nested2",
						"message": map[string]any{
							"id": "msg-sub-2",
							"content": []map[string]any{
								{"type": "text", "text": "deep leaf"},
							},
						},
					})
				}
				p.EmitJSON(map[string]any{
					"type":       "user",
					"session_id": cfg.SessionID,
					"message": map[string]any{
						"content": []map[string]any{
							{"type": "tool_result", "tool_use_id": "toolu_sub1", "is_error": false, "content": "scan ok"},
						},
					},
				})
			}

			resFrame := map[string]any{
				"type":       "result",
				"subtype":    "success",
				"is_error":   false,
				"result":     "done: " + content,
				"session_id": cfg.SessionID,
			}
			if cfg.TurnResultUsage != nil {
				resFrame["modelUsage"] = cfg.TurnResultUsage
			}
			if cfg.TurnFlatUsage != nil {
				resFrame["usage"] = cfg.TurnFlatUsage
			}
			if cfg.TurnTotalCostUSD != nil {
				resFrame["total_cost_usd"] = *cfg.TurnTotalCostUSD
			}
			p.EmitJSON(resFrame)
		}
	}
}

// CodexFixtureConfig configures a simulated Codex app-server CLI for offline replay tests.
type CodexFixtureConfig struct {
	ThreadID           string
	ChildThreadID      string
	ResumeBaseline     map[string]any
	ResumeInResponse   bool
	OmitResumeBaseline bool
	TurnTotalUsage     map[string]any
	ChildTurnUsage     map[string]any
	HoldCompaction     bool
}

// CodexFixtureHandler builds a stateful StdinHandler simulating Codex app-server JSON-RPC.
func CodexFixtureHandler(cfg CodexFixtureConfig) (StdinHandler, func(p *ScriptedProcess)) {
	if cfg.ThreadID == "" {
		cfg.ThreadID = "codex-thread-root"
	}
	if cfg.ChildThreadID == "" {
		cfg.ChildThreadID = "codex-thread-child-1"
	}
	var turnSeq int
	var mu sync.Mutex
	var compactTurnID = "compact-turn-1"

	finishCompaction := func(p *ScriptedProcess) {
		p.EmitJSON(map[string]any{
			"jsonrpc": "2.0",
			"method":  "item/completed",
			"params": map[string]any{
				"threadId": cfg.ThreadID,
				"turnId":   compactTurnID,
				"item": map[string]any{
					"id":   "cmp-1",
					"type": "contextCompaction",
				},
			},
		})
		p.EmitJSON(map[string]any{
			"jsonrpc": "2.0",
			"method":  "turn/completed",
			"params": map[string]any{
				"threadId": cfg.ThreadID,
				"turn": map[string]any{
					"id":     compactTurnID,
					"status": "completed",
				},
			},
		})
	}

	handler := func(p *ScriptedProcess, line []byte) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				ThreadID string `json:"threadId"`
				TurnID   string `json:"turnId"`
				Input    []struct {
					Text string `json:"text"`
				} `json:"input"`
			} `json:"params"`
		}
		if json.Unmarshal(line, &req) != nil {
			return
		}
		reply := func(result any) {
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result":  result,
			})
		}

		switch req.Method {
		case "initialize":
			reply(map[string]any{"serverInfo": map[string]any{"name": "codex-fake", "version": "1.0"}})

		case "thread/start":
			reply(map[string]any{
				"thread": map[string]any{"id": cfg.ThreadID},
			})

		case "thread/resume":
			res := map[string]any{
				"thread": map[string]any{"id": cfg.ThreadID},
			}
			if cfg.ResumeInResponse && cfg.ResumeBaseline != nil {
				res["tokenUsage"] = map[string]any{"total": cfg.ResumeBaseline}
			}
			reply(res)
			if !cfg.ResumeInResponse && !cfg.OmitResumeBaseline && cfg.ResumeBaseline != nil {
				p.EmitJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  "thread/tokenUsage/updated",
					"params": map[string]any{
						"threadId": cfg.ThreadID,
						"tokenUsage": map[string]any{
							"total": cfg.ResumeBaseline,
						},
					},
				})
			}

		case "turn/start":
			mu.Lock()
			turnSeq++
			turnID := "codex-turn-" + string(rune('0'+turnSeq))
			mu.Unlock()

			reply(map[string]any{"turn": map[string]any{"id": turnID}})
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "turn/started",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turn":     map[string]any{"id": turnID},
				},
			})

			inputText := ""
			if len(req.Params.Input) > 0 {
				inputText = req.Params.Input[0].Text
			}

			if strings.Contains(inputText, "hold") {
				p.EmitJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  "item/agentMessage/delta",
					"params": map[string]any{
						"threadId": cfg.ThreadID,
						"turnId":   turnID,
						"delta":    "working ",
					},
				})
				return
			}

			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "mcpServer/startupStatus/updated",
				"params": map[string]any{
					"name":     "vibevalley",
					"threadId": cfg.ThreadID,
					"status":   "ready",
				},
			})
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/reasoning/summaryTextDelta",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turnId":   turnID,
					"delta":    "analyzing repo",
				},
			})
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/started",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turnId":   turnID,
					"item": map[string]any{
						"id":      "cmd-1",
						"type":    "commandExecution",
						"command": "go test ./...",
					},
				},
			})
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/completed",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turnId":   turnID,
					"item": map[string]any{
						"id":               "cmd-1",
						"type":             "commandExecution",
						"status":           "completed",
						"exitCode":         0,
						"aggregatedOutput": "ok",
					},
				},
			})

			if cfg.ChildThreadID != "" {
				p.EmitJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  "item/started",
					"params": map[string]any{
						"threadId": cfg.ThreadID,
						"turnId":   turnID,
						"subAgentActivity": map[string]any{
							"agentThreadId": cfg.ChildThreadID,
						},
						"item": map[string]any{
							"id":   "child-msg-1",
							"type": "agentMessage",
						},
					},
				})
				p.EmitJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  "item/agentMessage/delta",
					"params": map[string]any{
						"threadId": cfg.ChildThreadID,
						"turnId":   "child-turn-1",
						"delta":    "child output",
					},
				})
				if cfg.ChildTurnUsage != nil {
					p.EmitJSON(map[string]any{
						"jsonrpc": "2.0",
						"method":  "thread/tokenUsage/updated",
						"params": map[string]any{
							"threadId": cfg.ChildThreadID,
							"turnId":   "child-turn-1",
							"tokenUsage": map[string]any{
								"total": cfg.ChildTurnUsage,
							},
						},
					})
				}
			}

			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/agentMessage/delta",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turnId":   turnID,
					"delta":    "codex: " + inputText,
				},
			})
			if cfg.TurnTotalUsage != nil {
				p.EmitJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  "thread/tokenUsage/updated",
					"params": map[string]any{
						"threadId": cfg.ThreadID,
						"turnId":   turnID,
						"tokenUsage": map[string]any{
							"total":              cfg.TurnTotalUsage,
							"modelContextWindow": 200000,
							"last": map[string]any{
								"inputTokens":       500,
								"cachedInputTokens": 100,
								"outputTokens":      50,
							},
						},
					},
				})
			}
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "turn/completed",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turn": map[string]any{
						"id":     turnID,
						"status": "completed",
					},
				},
			})

		case "turn/steer":
			reply(map[string]any{})
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/agentMessage/delta",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turnId":   req.Params.ThreadID,
					"delta":    "steered",
				},
			})

		case "turn/interrupt":
			reply(map[string]any{})
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "turn/completed",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turn": map[string]any{
						"id":     req.Params.TurnID,
						"status": "interrupted",
					},
				},
			})

		case "thread/compact/start":
			reply(map[string]any{})
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "item/started",
				"params": map[string]any{
					"threadId": cfg.ThreadID,
					"turnId":   compactTurnID,
					"item": map[string]any{
						"id":   "cmp-1",
						"type": "contextCompaction",
					},
				},
			})
			if !cfg.HoldCompaction {
				finishCompaction(p)
			}
		}
	}
	return handler, finishCompaction
}

// ACPFixtureConfig configures a simulated ACP JSON-RPC 2.0 CLI (OpenCode, Grok, Kimi, CodeBuddy).
type ACPFixtureConfig struct {
	SessionID         string
	ChildSessionID    string
	OpenCodeChildMeta bool
	SupportResume     bool
	SupportClose      bool
	EmitPermissionReq bool
	EmitUsage         map[string]any
}

// ACPFixtureHandler builds a stateful StdinHandler simulating stdio ACP JSON-RPC 2.0.
func ACPFixtureHandler(cfg ACPFixtureConfig) StdinHandler {
	if cfg.SessionID == "" {
		cfg.SessionID = "acp-sess-1"
	}
	return func(p *ScriptedProcess, line []byte) {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				SessionID string `json:"sessionId"`
				Prompt    []struct {
					Text string `json:"text"`
				} `json:"prompt"`
			} `json:"params"`
		}
		if json.Unmarshal(line, &msg) != nil {
			return
		}
		reply := func(result any) {
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(msg.ID),
				"result":  result,
			})
		}

		switch msg.Method {
		case "initialize":
			sessCaps := map[string]any{}
			if cfg.SupportResume {
				sessCaps["resume"] = map[string]any{}
			} else {
				sessCaps["load"] = map[string]any{}
			}
			if cfg.SupportClose {
				sessCaps["close"] = map[string]any{}
			}
			reply(map[string]any{
				"protocolVersion": 1,
				"agentCapabilities": map[string]any{
					"loadSession":         true,
					"sessionCapabilities": sessCaps,
				},
			})
		case "session/new", "session/resume", "session/load":
			sid := cfg.SessionID
			if msg.Params.SessionID != "" {
				sid = msg.Params.SessionID
			}
			reply(map[string]any{
				"sessionId": sid,
				"configOptions": []map[string]any{
					{"id": "model", "category": "model"},
					{"id": "reasoning_effort", "category": "thought_level"},
				},
			})
		case "session/set_config_option", "session/set_model", "session/close":
			reply(map[string]any{})
		case "session/prompt":
			if cfg.EmitPermissionReq {
				p.EmitJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      99,
					"method":  "session/request_permission",
					"params": map[string]any{
						"options": []map[string]any{
							{"optionId": "allow-once", "kind": "allow_once"},
						},
					},
				})
			}
			p.EmitJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": msg.Params.SessionID,
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content":       map[string]any{"type": "text", "text": "acp hello"},
					},
				},
			})
			if cfg.ChildSessionID != "" {
				params := map[string]any{
					"sessionId": cfg.ChildSessionID,
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content":       map[string]any{"type": "text", "text": "child chunk"},
					},
				}
				if cfg.OpenCodeChildMeta {
					params["sessionId"] = msg.Params.SessionID
					params["_meta"] = map[string]any{
						"opencode/child-session": map[string]any{
							"sessionId":       cfg.ChildSessionID,
							"parentSessionId": msg.Params.SessionID,
						},
					}
				}
				p.EmitJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  "session/update",
					"params":  params,
				})
			}
			res := map[string]any{"stopReason": "end_turn"}
			if cfg.EmitUsage != nil {
				res["usage"] = cfg.EmitUsage
			}
			reply(res)
		case "session/cancel":
			reply(map[string]any{"stopReason": "cancelled"})
		}
	}
}

// SDKStreamFixtureHandler simulates Qwen / Qoder bidirectional stream-json CLIs.
func SDKStreamFixtureHandler(sessionID string, usage map[string]any) StdinHandler {
	if sessionID == "" {
		sessionID = "sdk-sess-1"
	}
	return func(p *ScriptedProcess, line []byte) {
		var msg struct {
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype string `json:"subtype"`
				TaskID  string `json:"task_id"`
			} `json:"request"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &msg) != nil {
			return
		}
		switch msg.Type {
		case "control_request":
			p.EmitJSON(map[string]any{
				"type": "control_response",
				"response": map[string]any{
					"subtype":    "success",
					"request_id": msg.RequestID,
				},
			})
			if msg.Request.Subtype == "initialize" {
				p.EmitJSON(map[string]any{
					"type":       "system",
					"subtype":    "init",
					"session_id": sessionID,
				})
			} else if msg.Request.Subtype == "interrupt" {
				p.EmitJSON(map[string]any{
					"type":       "result",
					"subtype":    "aborted",
					"session_id": sessionID,
				})
			} else if msg.Request.Subtype == "stop_task" {
				p.EmitJSON(map[string]any{
					"type":       "system",
					"subtype":    "task_notification",
					"task_id":    msg.Request.TaskID,
					"status":     "killed",
					"session_id": sessionID,
				})
			}
		case "user":
			if msg.Message.Content == "/compact" {
				p.EmitJSON(map[string]any{
					"type":       "system",
					"subtype":    "compact_boundary",
					"session_id": sessionID,
				})
				p.EmitJSON(map[string]any{
					"type":       "result",
					"subtype":    "success",
					"session_id": sessionID,
					"usage":      usage,
				})
				return
			}
			p.EmitJSON(map[string]any{
				"type":       "assistant",
				"session_id": sessionID,
				"message": map[string]any{
					"id": "sdk-msg-1",
					"content": []map[string]any{
						{"type": "text", "text": "sdk reply: " + msg.Message.Content},
					},
				},
			})
			res := map[string]any{
				"type":       "result",
				"subtype":    "success",
				"is_error":   false,
				"session_id": sessionID,
			}
			if usage != nil {
				res["usage"] = usage
			}
			p.EmitJSON(res)
		}
	}
}
