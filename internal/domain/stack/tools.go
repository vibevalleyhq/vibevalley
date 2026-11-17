package stack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	domainwatch "github.com/vibevalleyhq/vibevalley/internal/domain/watch"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	issueOverlayScopeKind = "issue"
	issueOverlayDocKind   = "issue.overlay"
)

type domainToolHandler func(ctx context.Context, conversationID string, rawArgs json.RawMessage) (json.RawMessage, error)

type registeredDomainTool struct {
	spec    durable.ToolSpec
	handler domainToolHandler
}

// DomainToolRegistry exposes in-process VibeValley domain tools backed by *Stack
// for both durable.ToolExecutor (LLM tool turns) and durable.CodeToolFunc (Goja run_code).
type DomainToolRegistry struct {
	stack *Stack
	tools map[string]registeredDomainTool
	order []string
}

// NewDomainToolRegistry builds the complete set of VibeValley domain tools operating on stack.
func NewDomainToolRegistry(s *Stack) *DomainToolRegistry {
	reg := &DomainToolRegistry{
		stack: s,
		tools: make(map[string]registeredDomainTool),
	}
	reg.registerAll()
	return reg
}

func (r *DomainToolRegistry) register(name, description string, schema map[string]any, handler domainToolHandler) {
	if _, exists := r.tools[name]; !exists {
		r.order = append(r.order, name)
	}
	r.tools[name] = registeredDomainTool{
		spec: durable.ToolSpec{
			Name:        name,
			Description: description,
			InputSchema: schema,
		},
		handler: handler,
	}
}

// Specs returns deterministic ToolSpecs for all registered domain tools.
func (r *DomainToolRegistry) Specs() []durable.ToolSpec {
	names := make([]string, len(r.order))
	copy(names, r.order)
	sort.Strings(names)
	out := make([]durable.ToolSpec, 0, len(names))
	for _, name := range names {
		out = append(out, r.tools[name].spec)
	}
	return out
}

// Executor returns a durable.ToolExecutor dispatching calls to registered domain tools.
func (r *DomainToolRegistry) Executor() durable.ToolExecutor {
	return r
}

// Execute implements durable.ToolExecutor.
func (r *DomainToolRegistry) Execute(ctx context.Context, conversationID string, call durable.ToolCall) (json.RawMessage, error) {
	if r == nil || r.stack == nil {
		return nil, fmt.Errorf("%w: stack not configured", ErrInvalidConfig)
	}
	if r.stack.closed.Load() {
		return nil, ErrClosed
	}

	name := strings.TrimSpace(call.ToolName)
	entry, ok := r.tools[name]
	if !ok && strings.Contains(name, ".") {
		alias := strings.ReplaceAll(name, ".", "_")
		entry, ok = r.tools[alias]
	}
	if !ok {
		return nil, fmt.Errorf("%w: %s", durable.ErrUnknownTool, call.ToolName)
	}

	args := call.ArgsJSON
	if len(strings.TrimSpace(string(args))) == 0 {
		args = json.RawMessage(`{}`)
	}
	return entry.handler(ctx, conversationID, args)
}

// CodeToolFunc returns a durable.CodeToolFunc adapter so Goja CodeMode scripts can invoke domain tools.
func (r *DomainToolRegistry) CodeToolFunc() durable.CodeToolFunc {
	return func(ctx context.Context, toolName string, args any) (any, error) {
		var rawArgs json.RawMessage
		if args == nil {
			rawArgs = json.RawMessage(`{}`)
		} else {
			b, err := json.Marshal(args)
			if err != nil {
				return nil, fmt.Errorf("domain tool %s: encode args: %w", toolName, err)
			}
			rawArgs = b
		}
		rawOut, err := r.Execute(ctx, "", durable.ToolCall{
			ToolName: toolName,
			ArgsJSON: rawArgs,
		})
		if err != nil {
			return nil, err
		}
		if len(rawOut) == 0 {
			return map[string]any{}, nil
		}
		var out any
		if err := json.Unmarshal(rawOut, &out); err != nil {
			return string(rawOut), nil
		}
		return out, nil
	}
}

func (r *DomainToolRegistry) registerAll() {
	r.registerIssueTools()
	r.registerChannelAndWatchTools()
	r.registerRepoAndAgentTools()
	r.registerPKMTools()
	r.registerMemoryTools()
	r.registerArtifactAndMachineTools()
}

// --- Issue tools ---

type issueOverlay struct {
	Title       *string               `json:"title,omitempty"`
	Description *string               `json:"description,omitempty"`
	Prompt      *string               `json:"prompt,omitempty"`
	RepoID      *string               `json:"repoId,omitempty"`
	AssigneeID  *string               `json:"assigneeId,omitempty"`
	ChannelID   *string               `json:"channelId,omitempty"`
	Rubric      *contract.RubricSpec  `json:"rubric,omitempty"`
	ClearRubric bool                  `json:"clearRubric,omitempty"`
	Status      *contract.IssueStatus `json:"status,omitempty"`
	UpdatedAtMs int64                 `json:"updatedAtMs,omitempty"`
}

func (r *DomainToolRegistry) loadOverlay(ctx context.Context, issueID string) (issueOverlay, bool) {
	if r.stack.Store == nil || issueID == "" {
		return issueOverlay{}, false
	}
	doc, err := r.stack.Store.GetDocument(ctx, issueOverlayScopeKind, issueID, issueOverlayDocKind)
	if err != nil || len(doc.StateJSON) == 0 {
		return issueOverlay{}, false
	}
	var ov issueOverlay
	if json.Unmarshal(doc.StateJSON, &ov) != nil {
		return issueOverlay{}, false
	}
	return ov, true
}

func (r *DomainToolRegistry) saveOverlay(ctx context.Context, issueID string, ov issueOverlay) error {
	if r.stack.Store == nil {
		return nil
	}
	b, err := json.Marshal(ov)
	if err != nil {
		return err
	}
	_, err = r.stack.Store.PutDocument(ctx, issueOverlayScopeKind, issueID, issueOverlayDocKind, b)
	return err
}

func mergeIssueOverlay(iss issue.Issue, ov issueOverlay, has bool) issue.Issue {
	if !has {
		return iss
	}
	if ov.Title != nil {
		iss.Title = *ov.Title
	}
	if ov.Description != nil {
		iss.Description = *ov.Description
	}
	if ov.Prompt != nil {
		iss.Prompt = *ov.Prompt
	}
	if ov.RepoID != nil {
		iss.RepoID = *ov.RepoID
	}
	if ov.AssigneeID != nil {
		iss.AssigneeID = *ov.AssigneeID
	}
	if ov.ChannelID != nil {
		iss.ChannelID = *ov.ChannelID
	}
	if ov.ClearRubric {
		iss.Rubric = nil
	} else if ov.Rubric != nil {
		cp := *ov.Rubric
		iss.Rubric = &cp
	}
	if ov.Status != nil {
		iss.Status = *ov.Status
	}
	if ov.UpdatedAtMs > iss.UpdatedAtMs {
		iss.UpdatedAtMs = ov.UpdatedAtMs
	}
	return iss
}

func (r *DomainToolRegistry) getMergedIssue(ctx context.Context, id string) (issue.Issue, error) {
	if r.stack.Issues == nil {
		return issue.Issue{}, errors.New("issue service not configured")
	}
	iss, err := r.stack.Issues.GetIssue(ctx, id)
	if err != nil {
		return issue.Issue{}, err
	}
	ov, ok := r.loadOverlay(ctx, iss.ID)
	return mergeIssueOverlay(iss, ov, ok), nil
}

func (r *DomainToolRegistry) registerIssueTools() {
	r.register(
		"issue_list",
		"列出工单：可按状态（draft/queued/in_progress/review/done）、仓库、关键字筛选。",
		schemaObj(map[string]any{
			"status":   schemaStr("按单个状态筛选：draft、queued、in_progress、review、done"),
			"statuses": schemaStrArray("按多个状态筛选"),
			"repoId":   schemaStr("只列出所属仓库 ID 匹配的工单"),
			"text":     schemaStr("按标题、说明或 ID 关键字模糊筛选"),
			"limit":    schemaInt("最多返回条数，默认 50"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Issues == nil {
				return nil, errors.New("issue service not configured")
			}
			var in struct {
				Status   string   `json:"status"`
				Statuses []string `json:"statuses"`
				RepoID   string   `json:"repoId"`
				Text     string   `json:"text"`
				Limit    int      `json:"limit"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}

			wantStatuses := make(map[contract.IssueStatus]bool)
			if s := strings.TrimSpace(in.Status); s != "" {
				st := contract.IssueStatus(s)
				if !issue.ValidStatus(st) {
					return nil, fmt.Errorf("%w: invalid status %q", issue.ErrInvalidArgument, s)
				}
				wantStatuses[st] = true
			}
			for _, s := range in.Statuses {
				if trimmed := strings.TrimSpace(s); trimmed != "" {
					st := contract.IssueStatus(trimmed)
					if !issue.ValidStatus(st) {
						return nil, fmt.Errorf("%w: invalid status %q", issue.ErrInvalidArgument, trimmed)
					}
					wantStatuses[st] = true
				}
			}

			all, err := r.stack.Issues.ListIssues(ctx)
			if err != nil {
				return nil, err
			}

			textLower := strings.ToLower(strings.TrimSpace(in.Text))
			repoFilter := strings.TrimSpace(in.RepoID)
			filtered := make([]issue.Issue, 0, len(all))
			for _, item := range all {
				ov, has := r.loadOverlay(ctx, item.ID)
				merged := mergeIssueOverlay(item, ov, has)
				if len(wantStatuses) > 0 && !wantStatuses[merged.Status] {
					continue
				}
				if repoFilter != "" && merged.RepoID != repoFilter {
					continue
				}
				if textLower != "" {
					hay := strings.ToLower(merged.ID + "\n" + merged.Title + "\n" + merged.Description + "\n" + merged.Prompt)
					if !strings.Contains(hay, textLower) {
						continue
					}
				}
				filtered = append(filtered, merged)
			}

			total := len(filtered)
			limit := in.Limit
			if limit <= 0 {
				limit = 50
			}
			if len(filtered) > limit {
				filtered = filtered[:limit]
			}
			return encodeToolResult(map[string]any{
				"issues": filtered,
				"total":  total,
			})
		},
	)

	r.register(
		"issue_get",
		"获取单张工单的完整详情（状态、仓库、指派帮工、验收标准、迭代结果等）。",
		schemaObjRequired(map[string]any{
			"id": schemaStr("工单 ID"),
		}, "id"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			var in struct {
				ID string `json:"id"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			if strings.TrimSpace(in.ID) == "" {
				return nil, fmt.Errorf("%w: id is required", issue.ErrInvalidArgument)
			}
			iss, err := r.getMergedIssue(ctx, strings.TrimSpace(in.ID))
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{"issue": iss})
		},
	)

	r.register(
		"issue_create",
		"创建一张新工单；传 dispatch=true 时立即绑定监视任务并派发执行，不传则停留在 draft。",
		schemaObjRequired(map[string]any{
			"id":          schemaStr("可选自定义工单 ID"),
			"title":       schemaStr("工单标题（必填）"),
			"description": schemaStr("工单说明"),
			"prompt":      schemaStr("派发给帮工的任务提示词"),
			"repoId":      schemaStr("所属仓库 ID"),
			"assigneeId":  schemaStr("指派帮工 ID"),
			"channelId":   schemaStr("关联频道 ID"),
			"status":      schemaStr("初始状态，默认 draft"),
			"dispatch":    schemaBool("是否立即派发开工"),
			"rubric": map[string]any{
				"type":        "object",
				"description": "可选验收 Rubric",
				"properties": map[string]any{
					"markdown":      schemaStr("验收标准 Markdown"),
					"maxIterations": schemaInt("最大修订轮数"),
				},
			},
		}, "title"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Issues == nil {
				return nil, errors.New("issue service not configured")
			}
			var in struct {
				ID          string               `json:"id"`
				Title       string               `json:"title"`
				Description string               `json:"description"`
				Prompt      string               `json:"prompt"`
				RepoID      string               `json:"repoId"`
				AssigneeID  string               `json:"assigneeId"`
				ChannelID   string               `json:"channelId"`
				Status      contract.IssueStatus `json:"status"`
				Dispatch    bool                 `json:"dispatch"`
				Rubric      *contract.RubricSpec `json:"rubric"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			iss := issue.Issue{
				ID:          strings.TrimSpace(in.ID),
				Title:       strings.TrimSpace(in.Title),
				Description: in.Description,
				Prompt:      in.Prompt,
				Status:      in.Status,
				RepoID:      strings.TrimSpace(in.RepoID),
				AssigneeID:  strings.TrimSpace(in.AssigneeID),
				ChannelID:   strings.TrimSpace(in.ChannelID),
				Rubric:      in.Rubric,
			}
			if in.Dispatch {
				created, receipt, err := r.stack.CreateAndDispatchIssue(ctx, iss)
				if err != nil {
					return nil, err
				}
				return encodeToolResult(map[string]any{
					"issue":      created,
					"receipt":    receipt,
					"dispatched": true,
				})
			}
			created, err := r.stack.Issues.CreateIssue(ctx, iss)
			if err != nil {
				return nil, err
			}
			_ = r.stack.SyncSpaceProjection(ctx)
			return encodeToolResult(map[string]any{
				"issue":      created,
				"dispatched": false,
			})
		},
	)

	r.register(
		"issue_update",
		"更新工单的标题、说明、提示词、仓库、指派帮工或验收标准（Rubric）。",
		schemaObjRequired(map[string]any{
			"id":          schemaStr("工单 ID"),
			"title":       schemaStr("新标题"),
			"description": schemaStr("新说明"),
			"prompt":      schemaStr("新派发提示词"),
			"repoId":      schemaStr("新仓库 ID"),
			"assigneeId":  schemaStr("新指派帮工 ID"),
			"channelId":   schemaStr("新频道 ID"),
			"rubric": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"markdown":      schemaStr("验收标准 Markdown"),
					"maxIterations": schemaInt("最大修订轮数"),
				},
			},
			"clearRubric": schemaBool("是否清空验收标准"),
		}, "id"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			var in struct {
				ID          string               `json:"id"`
				Title       *string              `json:"title"`
				Description *string              `json:"description"`
				Prompt      *string              `json:"prompt"`
				RepoID      *string              `json:"repoId"`
				AssigneeID  *string              `json:"assigneeId"`
				ChannelID   *string              `json:"channelId"`
				Rubric      *contract.RubricSpec `json:"rubric"`
				ClearRubric bool                 `json:"clearRubric"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			id := strings.TrimSpace(in.ID)
			if id == "" {
				return nil, fmt.Errorf("%w: id is required", issue.ErrInvalidArgument)
			}
			base, err := r.stack.Issues.GetIssue(ctx, id)
			if err != nil {
				return nil, err
			}
			ov, _ := r.loadOverlay(ctx, id)
			if in.Title != nil {
				t := strings.TrimSpace(*in.Title)
				if t == "" {
					return nil, fmt.Errorf("%w: title cannot be empty", issue.ErrInvalidArgument)
				}
				ov.Title = &t
			}
			if in.Description != nil {
				ov.Description = in.Description
			}
			if in.Prompt != nil {
				ov.Prompt = in.Prompt
			}
			if in.RepoID != nil {
				v := strings.TrimSpace(*in.RepoID)
				ov.RepoID = &v
			}
			if in.AssigneeID != nil {
				v := strings.TrimSpace(*in.AssigneeID)
				ov.AssigneeID = &v
			}
			if in.ChannelID != nil {
				v := strings.TrimSpace(*in.ChannelID)
				ov.ChannelID = &v
			}
			if in.ClearRubric {
				ov.ClearRubric = true
				ov.Rubric = nil
			} else if in.Rubric != nil {
				cp := *in.Rubric
				ov.Rubric = &cp
				ov.ClearRubric = false
			}
			ov.UpdatedAtMs = r.stack.clock.NowMs()
			if err := r.saveOverlay(ctx, id, ov); err != nil {
				return nil, err
			}
			merged := mergeIssueOverlay(base, ov, true)
			if r.stack.Game != nil {
				_, _ = r.stack.Game.UpsertIssue(merged.View())
			}
			return encodeToolResult(map[string]any{"issue": merged})
		},
	)

	r.register(
		"issue_transition",
		"流转工单状态：支持 draft、queued、in_progress、review、done。",
		schemaObjRequired(map[string]any{
			"id":      schemaStr("工单 ID"),
			"status":  schemaStr("目标状态：draft、queued、in_progress、review、done"),
			"summary": schemaStr("状态变更说明或交付结论"),
			"prUrl":   schemaStr("可选 PR 地址"),
		}, "id", "status"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Issues == nil {
				return nil, errors.New("issue service not configured")
			}
			var in struct {
				ID      string `json:"id"`
				Status  string `json:"status"`
				Summary string `json:"summary"`
				PRURL   string `json:"prUrl"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			id := strings.TrimSpace(in.ID)
			target := contract.IssueStatus(strings.TrimSpace(in.Status))
			if id == "" || !issue.ValidStatus(target) {
				return nil, fmt.Errorf("%w: valid id and status required", issue.ErrInvalidArgument)
			}

			var updated issue.Issue
			var receipt *issue.DispatchReceipt
			var err error

			switch target {
			case contract.IssueQueued, contract.IssueInProgress:
				ov, has := r.loadOverlay(ctx, id)
				if has && ov.Status != nil {
					ov.Status = nil
					ov.UpdatedAtMs = r.stack.clock.NowMs()
					_ = r.saveOverlay(ctx, id, ov)
				}
				updated, receipt, err = r.stack.QueueAndDispatchIssue(ctx, id)
				if err != nil {
					return nil, err
				}
				ov, has = r.loadOverlay(ctx, id)
				updated = mergeIssueOverlay(updated, ov, has)

			case contract.IssueReview:
				updated, err = r.stack.Issues.HandlePRCheckResult(ctx, id, false, in.Summary, in.PRURL)
				if err != nil {
					return nil, err
				}
				ov, has := r.loadOverlay(ctx, id)
				if has && ov.Status != nil {
					ov.Status = nil
					ov.UpdatedAtMs = r.stack.clock.NowMs()
					_ = r.saveOverlay(ctx, id, ov)
				}
				updated = mergeIssueOverlay(updated, ov, has)

			case contract.IssueDone:
				updated, err = r.stack.Issues.HandlePRCheckResult(ctx, id, true, in.Summary, in.PRURL)
				if err != nil {
					return nil, err
				}
				ov, has := r.loadOverlay(ctx, id)
				if has && ov.Status != nil {
					ov.Status = nil
					ov.UpdatedAtMs = r.stack.clock.NowMs()
					_ = r.saveOverlay(ctx, id, ov)
				}
				updated = mergeIssueOverlay(updated, ov, has)

			case contract.IssueDraft:
				base, gErr := r.stack.Issues.GetIssue(ctx, id)
				if gErr != nil {
					return nil, gErr
				}
				ov, _ := r.loadOverlay(ctx, id)
				st := contract.IssueDraft
				ov.Status = &st
				ov.UpdatedAtMs = r.stack.clock.NowMs()
				if err := r.saveOverlay(ctx, id, ov); err != nil {
					return nil, err
				}
				updated = mergeIssueOverlay(base, ov, true)
			}

			if r.stack.Game != nil {
				_, _ = r.stack.Game.UpsertIssue(updated.View())
			}
			return encodeToolResult(map[string]any{
				"issue":   updated,
				"receipt": receipt,
			})
		},
	)

	r.register(
		"issue_dispatch",
		"为已有工单绑定 durable 监视任务并立即排队派发执行。",
		schemaObjRequired(map[string]any{
			"id": schemaStr("工单 ID"),
		}, "id"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			var in struct {
				ID string `json:"id"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			id := strings.TrimSpace(in.ID)
			if id == "" {
				return nil, fmt.Errorf("%w: id is required", issue.ErrInvalidArgument)
			}
			ov, has := r.loadOverlay(ctx, id)
			if has && ov.Status != nil {
				ov.Status = nil
				ov.UpdatedAtMs = r.stack.clock.NowMs()
				_ = r.saveOverlay(ctx, id, ov)
			}
			updated, receipt, err := r.stack.QueueAndDispatchIssue(ctx, id)
			if err != nil {
				return nil, err
			}
			merged := mergeIssueOverlay(updated, ov, has)
			return encodeToolResult(map[string]any{
				"issue":   merged,
				"receipt": receipt,
			})
		},
	)
}

// --- Channel & Watch tools ---

func (r *DomainToolRegistry) registerChannelAndWatchTools() {
	r.register(
		"channel_list",
		"列出所有频道（公共频道、私聊、工单串），可按类型筛选。",
		schemaObj(map[string]any{
			"type": schemaStr("可选筛选：channel、direct、thread"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Channels == nil {
				return nil, errors.New("channel store not configured")
			}
			var in struct {
				Type string `json:"type"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			all, err := r.stack.Channels.ListChannels(ctx)
			if err != nil {
				return nil, err
			}
			filterType := strings.TrimSpace(in.Type)
			var out []channel.Channel
			for _, ch := range all {
				if filterType != "" && string(ch.Type) != filterType {
					continue
				}
				out = append(out, ch)
			}
			return encodeToolResult(map[string]any{
				"channels": out,
				"total":    len(out),
			})
		},
	)

	r.register(
		"channel_messages",
		"读取指定频道或工单串里的消息事件列表。",
		schemaObj(map[string]any{
			"channelId": schemaStr("频道 ID（省略时自动选取默认频道）"),
			"afterSeq":  schemaInt("仅返回序号大于 afterSeq 的事件"),
			"limit":     schemaInt("最多返回条数，默认 50"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Channels == nil {
				return nil, errors.New("channel store not configured")
			}
			var in struct {
				ChannelID string `json:"channelId"`
				AfterSeq  int64  `json:"afterSeq"`
				Limit     int    `json:"limit"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			chID := strings.TrimSpace(in.ChannelID)
			if chID == "" {
				chID, _ = r.defaultChannelID(ctx)
			}
			if chID == "" {
				return nil, fmt.Errorf("%w: channelId is required", channel.ErrInvalidArgument)
			}
			limit := in.Limit
			if limit <= 0 {
				limit = 50
			}
			events, err := r.stack.Channels.ListEvents(ctx, chID, in.AfterSeq, limit)
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{
				"channelId": chID,
				"events":    events,
				"total":     len(events),
			})
		},
	)

	r.register(
		"channel_post",
		"在频道或工单串里发送一条消息（支持 mentions @ 提醒与自动触发 Watch 路由与刹车）。",
		schemaObjRequired(map[string]any{
			"channelId": schemaStr("目标频道 ID"),
			"text":      schemaStr("消息正文"),
			"authorId":  schemaStr("发送者 ID，默认 orchestrator"),
			"actorKind": schemaStr("发送者角色：user、agent、system（默认 agent）"),
			"kind":      schemaStr("消息类型：message、question、report（默认 message）"),
			"mentions":  schemaStrArray("需要 @ 叫醒的参与者 ID 列表"),
			"issueId":   schemaStr("可选关联工单 ID"),
			"sessionId": schemaStr("可选关联会话 ID"),
			"sendKey":   schemaStr("可选幂等键"),
		}, "channelId", "text"),
		func(ctx context.Context, convID string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Channels == nil {
				return nil, errors.New("channel store not configured")
			}
			var in struct {
				ChannelID string   `json:"channelId"`
				Text      string   `json:"text"`
				AuthorID  string   `json:"authorId"`
				ActorKind string   `json:"actorKind"`
				Kind      string   `json:"kind"`
				Mentions  []string `json:"mentions"`
				IssueID   string   `json:"issueId"`
				SessionID string   `json:"sessionId"`
				SendKey   string   `json:"sendKey"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			authorID := strings.TrimSpace(in.AuthorID)
			if authorID == "" {
				authorID = "orchestrator"
			}
			actorKind := channel.ActorKind(strings.TrimSpace(in.ActorKind))
			if actorKind == "" {
				actorKind = channel.ActorAgent
			}
			evKind := contract.ChannelEventKind(strings.TrimSpace(in.Kind))
			if evKind == "" {
				evKind = contract.ChannelEventMessage
			}
			sessID := strings.TrimSpace(in.SessionID)
			if sessID == "" {
				sessID = convID
			}
			res, outcomes, err := r.stack.PostAndPumpChannel(ctx, channel.AppendRequest{
				ChannelID: strings.TrimSpace(in.ChannelID),
				Kind:      evKind,
				AuthorID:  authorID,
				ActorKind: actorKind,
				Text:      in.Text,
				SessionID: sessID,
				IssueID:   strings.TrimSpace(in.IssueID),
				Mentions:  in.Mentions,
				SendKey:   strings.TrimSpace(in.SendKey),
			})
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{
				"event":        res.Event,
				"deduplicated": res.Deduplicated,
				"outcomes":     outcomes,
			})
		},
	)

	r.register(
		"watch_report",
		"读取 Watch 收件箱/席位/刹车现状，或提交结构化汇报与已读/处理确认。",
		schemaObj(map[string]any{
			"channelId":       schemaStr("可选频道 ID，用于筛选席位或发送汇报"),
			"agentId":         schemaStr("可选帮工 ID，提交汇报时同步重置空唤醒熔断计数"),
			"authorId":        schemaStr("可选汇报发送者 ID"),
			"issueId":         schemaStr("可选关联工单 ID"),
			"summary":         schemaStr("若非空，则向 channelId 发送一条结构化 Report 事件"),
			"outcome":         schemaStr("汇报结果：completed、failed、interrupted（默认 completed）"),
			"delivered":       schemaStr("交付物说明"),
			"includeResolved": schemaBool("是否包含已解决的 Inbox 条目"),
			"resolveInboxId":  schemaStr("可选将指定 Inbox 条目标记为已处理"),
		}),
		func(ctx context.Context, convID string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Watch == nil {
				return nil, errors.New("watch service not configured")
			}
			var in struct {
				ChannelID       string `json:"channelId"`
				AgentID         string `json:"agentId"`
				AuthorID        string `json:"authorId"`
				IssueID         string `json:"issueId"`
				Summary         string `json:"summary"`
				Outcome         string `json:"outcome"`
				Delivered       string `json:"delivered"`
				IncludeResolved bool   `json:"includeResolved"`
				ResolveInboxID  string `json:"resolveInboxId"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}

			var posted *channel.Event
			if strings.TrimSpace(in.Summary) != "" {
				chID := strings.TrimSpace(in.ChannelID)
				if chID == "" {
					chID, _ = r.defaultChannelID(ctx)
				}
				if chID == "" {
					return nil, fmt.Errorf("%w: channelId required to post watch report", domainwatch.ErrInvalidArgument)
				}
				authorID := firstNonEmpty(in.AuthorID, in.AgentID, "orchestrator")
				outcome := firstNonEmpty(in.Outcome, "completed")
				res, _, err := r.stack.PostAndPumpChannel(ctx, channel.AppendRequest{
					ChannelID: chID,
					Kind:      contract.ChannelEventReport,
					AuthorID:  authorID,
					ActorKind: channel.ActorAgent,
					Text:      in.Summary,
					SessionID: convID,
					IssueID:   strings.TrimSpace(in.IssueID),
					Report: &channel.ReportSummary{
						IssueID:   strings.TrimSpace(in.IssueID),
						Outcome:   outcome,
						Summary:   in.Summary,
						Delivered: in.Delivered,
					},
				})
				if err != nil {
					return nil, err
				}
				ev := res.Event
				posted = &ev
				if agentID := strings.TrimSpace(in.AgentID); agentID != "" {
					_ = r.stack.Watch.RecordSpoke(ctx, agentID)
				}
			}

			resolved := false
			if rid := strings.TrimSpace(in.ResolveInboxID); rid != "" {
				ok, err := r.stack.Watch.ResolveInboxItem(ctx, rid)
				if err != nil {
					return nil, err
				}
				resolved = ok
				_ = r.stack.SyncSpaceProjection(ctx)
			}

			cursor, err := r.stack.Watch.Cursor(ctx)
			if err != nil {
				return nil, err
			}
			inbox, err := r.stack.Watch.ListInboxItems(ctx, in.IncludeResolved)
			if err != nil {
				return nil, err
			}
			seats, err := r.stack.Watch.ListSeats(ctx, strings.TrimSpace(in.ChannelID))
			if err != nil {
				return nil, err
			}
			brakes, err := r.stack.Watch.BrakeStateSnapshot(ctx)
			if err != nil {
				return nil, err
			}

			return encodeToolResult(map[string]any{
				"cursor":          cursor,
				"inbox":           inbox,
				"seats":           seats,
				"brakes":          brakes,
				"postedEvent":     posted,
				"inboxResolved":   resolved,
				"unresolvedCount": countUnresolvedInbox(inbox),
			})
		},
	)
}

func (r *DomainToolRegistry) defaultChannelID(ctx context.Context) (string, bool) {
	if r.stack.Channels == nil {
		return "", false
	}
	list, err := r.stack.Channels.ListChannels(ctx)
	if err != nil || len(list) == 0 {
		return "", false
	}
	for _, ch := range list {
		if ch.IsDefault {
			return ch.ID, true
		}
	}
	return list[0].ID, true
}

func countUnresolvedInbox(items []contract.InboxItemView) int {
	n := 0
	for _, it := range items {
		if !it.Resolved {
			n++
		}
	}
	return n
}

// --- Repo & Agent tools ---

func (r *DomainToolRegistry) registerRepoAndAgentTools() {
	r.register(
		"repo_list",
		"列出所有已登记的 Git 仓库与工作目录根路径。",
		schemaObj(map[string]any{}),
		func(ctx context.Context, _ string, _ json.RawMessage) (json.RawMessage, error) {
			if r.stack.Repos == nil {
				return nil, errors.New("repo registry not configured")
			}
			repos, err := r.stack.Repos.ListRepos(ctx)
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{
				"repos":    repos,
				"workRoot": r.stack.WorkRoot(),
				"total":    len(repos),
			})
		},
	)

	r.register(
		"repo_register",
		"登记一个已有 Git 仓库目录，或在工作目录下初始化新仓库（init=true 或未提供 rootPath）。",
		schemaObjRequired(map[string]any{
			"id":            schemaStr("可选仓库 ID，默认与 name 相同"),
			"name":          schemaStr("仓库短名称（必填）"),
			"rootPath":      schemaStr("已有本地仓库路径；省略或 init=true 时在 workRoot 下初始化新仓库"),
			"defaultBranch": schemaStr("默认分支，默认 main"),
			"remoteUrl":     schemaStr("可选远程 Git 地址"),
			"init":          schemaBool("是否在 workRoot 下新建并初始化 Git 仓库"),
		}, "name"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Repos == nil {
				return nil, errors.New("repo registry not configured")
			}
			var in struct {
				ID            string `json:"id"`
				Name          string `json:"name"`
				RootPath      string `json:"rootPath"`
				DefaultBranch string `json:"defaultBranch"`
				RemoteURL     string `json:"remoteUrl"`
				Init          bool   `json:"init"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			var rp repo.Repository
			var err error
			if in.Init || strings.TrimSpace(in.RootPath) == "" {
				rp, err = r.stack.Repos.CreateOrInitRepo(ctx, strings.TrimSpace(in.ID), strings.TrimSpace(in.Name), strings.TrimSpace(in.DefaultBranch), strings.TrimSpace(in.RemoteURL))
			} else {
				rp, err = r.stack.Repos.RegisterRepo(ctx, repo.Repository{
					ID:            strings.TrimSpace(in.ID),
					Name:          strings.TrimSpace(in.Name),
					RootPath:      strings.TrimSpace(in.RootPath),
					DefaultBranch: strings.TrimSpace(in.DefaultBranch),
					RemoteURL:     strings.TrimSpace(in.RemoteURL),
				})
			}
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{"repo": rp})
		},
	)

	r.register(
		"agent_list",
		"列出所有已配置的帮工与助手档案及 runtime 安装状态。",
		schemaObj(map[string]any{
			"role":            schemaStr("可选筛选角色：orchestrator 或 worker"),
			"includeRuntimes": schemaBool("是否附带 runtime 状态列表，默认 true"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Agents == nil {
				return nil, errors.New("agent registry not configured")
			}
			var in struct {
				Role            string `json:"role"`
				IncludeRuntimes *bool  `json:"includeRuntimes"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			profiles, err := r.stack.Agents.ListProfiles(ctx)
			if err != nil {
				return nil, err
			}
			roleFilter := agent.Role(strings.TrimSpace(in.Role))
			var filtered []agent.Profile
			for _, p := range profiles {
				if roleFilter != "" && p.Role != roleFilter {
					continue
				}
				filtered = append(filtered, p)
			}
			res := map[string]any{
				"agents": filtered,
				"total":  len(filtered),
			}
			if in.IncludeRuntimes == nil || *in.IncludeRuntimes {
				runtimes, rErr := r.stack.Agents.ListRuntimes(ctx)
				if rErr != nil {
					return nil, rErr
				}
				res["runtimes"] = runtimes
			}
			return encodeToolResult(res)
		},
	)
}

// --- PKM tools ---

func (r *DomainToolRegistry) registerPKMTools() {
	r.register(
		"pkm_list",
		"列出 PKM 知识库里的笔记页面，可按 PARA 层级（project/area/resource/inbox/journal/archive）或标签筛选。",
		schemaObj(map[string]any{
			"tier":  schemaStr("可选 PARA 层级：project、area、resource、inbox、journal、archive"),
			"tag":   schemaStr("可选标签过滤"),
			"limit": schemaInt("最多返回条数，默认 20"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.PKM == nil {
				return nil, errors.New("pkm store not configured")
			}
			var in struct {
				Tier  string `json:"tier"`
				Tag   string `json:"tag"`
				Limit int    `json:"limit"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			hits, err := r.stack.PKM.Search(ctx, pkm.SearchQuery{
				Tier:  pkm.Tier(strings.TrimSpace(in.Tier)),
				Tag:   strings.TrimSpace(in.Tag),
				Limit: in.Limit,
			})
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{
				"notes": hits,
				"total": len(hits),
			})
		},
	)

	r.register(
		"pkm_read",
		"读取 PKM 知识库中的一篇笔记正文、前向链接、块索引与反向链接。",
		schemaObj(map[string]any{
			"path": schemaStr("笔记相对路径（如 01_Projects/plan.md）"),
			"ref":  schemaStr("笔记路径、slug 或标题别名"),
			"page": schemaStr("同 ref，兼容按页标题读取"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.PKM == nil {
				return nil, errors.New("pkm store not configured")
			}
			var in struct {
				Path string `json:"path"`
				Ref  string `json:"ref"`
				Page string `json:"page"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			target := firstNonEmpty(in.Path, in.Ref, in.Page)
			if target == "" {
				return nil, fmt.Errorf("%w: path or ref is required", pkm.ErrInvalidArgument)
			}
			note, ok, err := r.stack.PKM.GetNote(ctx, target)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, fmt.Errorf("%w: %q", pkm.ErrNotFound, target)
			}
			backlinks, err := r.stack.PKM.Backlinks(ctx, note.RelPath)
			if err != nil {
				backlinks = nil
			}
			return encodeToolResult(map[string]any{
				"note":      note,
				"backlinks": backlinks,
			})
		},
	)

	r.register(
		"pkm_write",
		"写入或更新 PKM 知识库中的一篇 Markdown 笔记并更新双链、全文与向量索引。",
		schemaObjRequired(map[string]any{
			"relPath": schemaStr("笔记相对路径（如 01_Projects/arch.md）；可省略并由 tier+title 自动生成"),
			"path":    schemaStr("relPath 的别名"),
			"title":   schemaStr("若省略 relPath，则根据标题自动生成路径"),
			"tier":    schemaStr("PARA 层级：inbox（默认）、project、area、resource、archive、journal"),
			"content": schemaStr("完整 Markdown 内容"),
		}, "content"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.PKM == nil {
				return nil, errors.New("pkm store not configured")
			}
			var in struct {
				RelPath string `json:"relPath"`
				Path    string `json:"path"`
				Title   string `json:"title"`
				Tier    string `json:"tier"`
				Content string `json:"content"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			relPath := firstNonEmpty(in.RelPath, in.Path)
			if relPath == "" {
				title := strings.TrimSpace(in.Title)
				if title == "" {
					return nil, fmt.Errorf("%w: relPath or title is required", pkm.ErrInvalidArgument)
				}
				tier := pkm.Tier(strings.TrimSpace(in.Tier))
				if tier == "" {
					tier = pkm.TierInbox
				}
				relPath = pkm.FolderForTier(tier) + "/" + strings.ReplaceAll(title, "/", "__") + ".md"
			}
			if !strings.HasSuffix(strings.ToLower(relPath), ".md") {
				relPath += ".md"
			}
			if !pkm.IsVaultMarkdownPath(relPath) {
				return nil, fmt.Errorf("%w: invalid markdown path %q", pkm.ErrInvalidPath, relPath)
			}
			note, err := r.stack.PKM.UpsertNote(ctx, pkm.NoteInput{
				RelPath:     relPath,
				Content:     []byte(in.Content),
				UpdatedAtMs: r.stack.clock.NowMs(),
			})
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{"note": note})
		},
	)

	r.register(
		"pkm_search",
		"在 PKM 知识库中按全文与双链条件检索笔记。",
		schemaObjRequired(map[string]any{
			"text":     schemaStr("搜索词或短语"),
			"tier":     schemaStr("可选 PARA 层级过滤"),
			"tag":      schemaStr("可选标签过滤"),
			"linkedTo": schemaStr("可选：仅返回链接到指定笔记标题或路径的笔记"),
			"limit":    schemaInt("最多返回条数，默认 20"),
		}, "text"),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.PKM == nil {
				return nil, errors.New("pkm store not configured")
			}
			var in struct {
				Text     string `json:"text"`
				Tier     string `json:"tier"`
				Tag      string `json:"tag"`
				LinkedTo string `json:"linkedTo"`
				Limit    int    `json:"limit"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			hits, err := r.stack.PKM.Search(ctx, pkm.SearchQuery{
				Text:     strings.TrimSpace(in.Text),
				Tier:     pkm.Tier(strings.TrimSpace(in.Tier)),
				Tag:      strings.TrimSpace(in.Tag),
				LinkedTo: strings.TrimSpace(in.LinkedTo),
				Limit:    in.Limit,
			})
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{
				"hits":  hits,
				"total": len(hits),
			})
		},
	)
}

// --- Memory tools ---

func (r *DomainToolRegistry) registerMemoryTools() {
	r.register(
		"memory_remember",
		"向不可变版本化 Memory 中写入一条长期经验、偏好或项目约定。",
		schemaObj(map[string]any{
			"scopeId":   schemaStr("作用域 ID，默认 default"),
			"relPath":   schemaStr("记忆文件名，默认 facts.md（缺省时自动追加到 facts.md）"),
			"content":   schemaStr("要记住的内容"),
			"text":      schemaStr("content 的别名"),
			"append":    schemaBool("是否追加到现有文件末尾；省略 relPath 时默认 true，指定 relPath 时默认覆盖"),
			"sessionId": schemaStr("可选关联会话 ID"),
			"summary":   schemaStr("本次版本提交说明"),
		}),
		func(ctx context.Context, convID string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Memory == nil {
				return nil, errors.New("memory store not configured")
			}
			var in struct {
				ScopeID   string `json:"scopeId"`
				RelPath   string `json:"relPath"`
				Content   string `json:"content"`
				Text      string `json:"text"`
				Append    *bool  `json:"append"`
				SessionID string `json:"sessionId"`
				Summary   string `json:"summary"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			body := strings.TrimSpace(firstNonEmpty(in.Content, in.Text))
			if body == "" {
				return nil, fmt.Errorf("%w: content is required", memory.ErrInvalidArgument)
			}
			scope := firstNonEmpty(in.ScopeID, memory.DefaultScopeID)
			explicitRel := strings.TrimSpace(in.RelPath)
			rel := explicitRel
			if rel == "" {
				rel = "facts.md"
			}
			appendMode := explicitRel == ""
			if in.Append != nil {
				appendMode = *in.Append
			}

			snap, err := r.stack.Memory.ActiveSnapshot(ctx, scope)
			if err != nil {
				return nil, err
			}
			var baseVer int64
			var nextContent []byte
			if existing, exists := snap.File(rel); exists {
				baseVer = existing.Version
				if appendMode {
					cur := strings.TrimRight(string(existing.Content), "\n")
					line := body
					if !strings.HasPrefix(line, "- ") && !strings.HasPrefix(line, "* ") && !strings.HasPrefix(line, "#") {
						line = "- " + line
					}
					if cur == "" {
						nextContent = []byte(line + "\n")
					} else {
						nextContent = []byte(cur + "\n" + line + "\n")
					}
				} else {
					nextContent = []byte(body)
				}
			} else if appendMode && !strings.HasPrefix(body, "- ") && !strings.HasPrefix(body, "* ") && !strings.HasPrefix(body, "#") {
				nextContent = []byte("- " + body + "\n")
			} else {
				nextContent = []byte(body)
			}

			sessID := firstNonEmpty(in.SessionID, convID)
			summary := firstNonEmpty(in.Summary, "remember "+rel)
			committed, err := r.stack.Memory.CommitFiles(ctx, memory.CommitRequest{
				ScopeID:         scope,
				ExpectedVersion: snap.Version,
				SessionID:       sessID,
				Summary:         summary,
				Files: []memory.MemoryFileInput{
					{
						RelPath:     rel,
						BaseVersion: baseVer,
						Content:     nextContent,
					},
				},
			})
			if err != nil {
				return nil, err
			}
			return encodeToolResult(map[string]any{
				"scopeId":  committed.ScopeID,
				"version":  committed.Version,
				"relPath":  rel,
				"snapshot": committed,
			})
		},
	)

	r.register(
		"memory_recall",
		"从当前激活的 Memory 快照中检索记忆条目或读取指定记忆文件。",
		schemaObj(map[string]any{
			"scopeId": schemaStr("作用域 ID，默认 default"),
			"query":   schemaStr("按关键字过滤匹配行或文件名"),
			"text":    schemaStr("query 的别名"),
			"relPath": schemaStr("可选限定单个记忆文件名"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Memory == nil {
				return nil, errors.New("memory store not configured")
			}
			var in struct {
				ScopeID string `json:"scopeId"`
				Query   string `json:"query"`
				Text    string `json:"text"`
				RelPath string `json:"relPath"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			scope := firstNonEmpty(in.ScopeID, memory.DefaultScopeID)
			snap, err := r.stack.Memory.ActiveSnapshot(ctx, scope)
			if err != nil {
				return nil, err
			}
			q := strings.ToLower(strings.TrimSpace(firstNonEmpty(in.Query, in.Text)))
			relFilter := strings.TrimSpace(in.RelPath)

			type recallFile struct {
				RelPath     string `json:"relPath"`
				Version     int64  `json:"version"`
				Content     string `json:"content"`
				UpdatedAtMs int64  `json:"updatedAtMs"`
			}
			type recallMatch struct {
				RelPath string `json:"relPath"`
				Version int64  `json:"version"`
				Line    string `json:"line"`
			}

			var files []recallFile
			var matches []recallMatch
			for _, f := range snap.Files {
				if relFilter != "" && f.RelPath != relFilter {
					continue
				}
				body := string(f.Content)
				if q == "" {
					files = append(files, recallFile{
						RelPath:     f.RelPath,
						Version:     f.Version,
						Content:     body,
						UpdatedAtMs: f.UpdatedAtMs,
					})
					continue
				}
				fileMatched := strings.Contains(strings.ToLower(f.RelPath), q)
				for line := range strings.SplitSeq(body, "\n") {
					trimmed := strings.TrimSpace(line)
					if trimmed == "" {
						continue
					}
					if strings.Contains(strings.ToLower(trimmed), q) {
						fileMatched = true
						matches = append(matches, recallMatch{
							RelPath: f.RelPath,
							Version: f.Version,
							Line:    trimmed,
						})
					}
				}
				if fileMatched {
					files = append(files, recallFile{
						RelPath:     f.RelPath,
						Version:     f.Version,
						Content:     body,
						UpdatedAtMs: f.UpdatedAtMs,
					})
				}
			}

			return encodeToolResult(map[string]any{
				"scopeId": scope,
				"version": snap.Version,
				"files":   files,
				"matches": matches,
			})
		},
	)
}

// --- Artifact & Machine tools ---

func (r *DomainToolRegistry) registerArtifactAndMachineTools() {
	r.register(
		"artifact_list",
		"列出已发布的 Artifact 交付物卡片，可按频道、工单或展示模式筛选。",
		schemaObj(map[string]any{
			"channelId": schemaStr("按频道 ID 筛选"),
			"issueId":   schemaStr("按工单 ID 筛选"),
			"display":   schemaStr("按展示模式筛选：page、slides、motion、canvas、dashboard、whiteboard"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Artifacts == nil || r.stack.Artifacts.Deliverables == nil {
				return nil, errors.New("artifact deliverables store not configured")
			}
			var in struct {
				ChannelID string `json:"channelId"`
				IssueID   string `json:"issueId"`
				Display   string `json:"display"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			cards := r.stack.Artifacts.Deliverables.ListCards(ctx, artifact.DeliverableFilter{
				ChannelID: strings.TrimSpace(in.ChannelID),
				IssueID:   strings.TrimSpace(in.IssueID),
				Display:   contract.ArtifactDisplayMode(strings.TrimSpace(in.Display)),
			})
			return encodeToolResult(map[string]any{
				"artifacts": cards,
				"total":     len(cards),
			})
		},
	)

	r.register(
		"artifact_publish",
		"校验/编译并发布一份版本化 HTML 或 TSX Artifact 交付物。",
		schemaObj(map[string]any{
			"id":        schemaStr("可选已有 Artifact ID（提供时发布新版本）"),
			"title":     schemaStr("Artifact 标题"),
			"display":   schemaStr("展示模式：page（默认）、slides、motion、canvas、dashboard、whiteboard"),
			"channelId": schemaStr("关联频道 ID"),
			"issueId":   schemaStr("关联工单 ID"),
			"note":      schemaStr("版本说明"),
			"author":    schemaStr("作者"),
			"entry":     schemaStr("打包入口文件（如 index.tsx）"),
			"files": map[string]any{
				"type":        "object",
				"description": "虚拟源码文件映射 {path: content}，与 rawHtml 二选一",
			},
			"rawHtml": schemaStr("自包含 HTML 原文，与 files 二选一"),
			"minify":  schemaBool("是否压缩输出"),
		}),
		func(ctx context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Artifacts == nil {
				return nil, errors.New("artifact service not configured")
			}
			return r.stack.Artifacts.ExecutePublishTool(ctx, rawArgs)
		},
	)

	r.register(
		"machine_list",
		"列出当前在线的远程执行节点（vibe-machine）以及活动租约。",
		schemaObj(map[string]any{
			"sessionId": schemaStr("可选按会话 ID 过滤租约"),
		}),
		func(_ context.Context, _ string, rawArgs json.RawMessage) (json.RawMessage, error) {
			if r.stack.Machines == nil {
				return nil, errors.New("machine hub not configured")
			}
			var in struct {
				SessionID string `json:"sessionId"`
			}
			if err := decodeToolArgs(rawArgs, &in); err != nil {
				return nil, err
			}
			online := r.stack.Machines.ListOnline()
			leases := r.stack.Machines.ListLeases(strings.TrimSpace(in.SessionID))
			return encodeToolResult(map[string]any{
				"machines": online,
				"leases":   leases,
				"count":    len(online),
			})
		},
	)
}

func decodeToolArgs(raw json.RawMessage, dst any) error {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("invalid tool arguments: %w", err)
	}
	return nil
}

func encodeToolResult(v any) (json.RawMessage, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(b), nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func schemaObj(props map[string]any) map[string]any {
	return map[string]any{
		"type":       "object",
		"properties": props,
	}
}

func schemaObjRequired(props map[string]any, req ...string) map[string]any {
	return map[string]any{
		"type":       "object",
		"properties": props,
		"required":   req,
	}
}

func schemaStr(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func schemaInt(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func schemaBool(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

func schemaStrArray(desc string) map[string]any {
	return map[string]any{
		"type":        "array",
		"description": desc,
		"items":       map[string]any{"type": "string"},
	}
}
