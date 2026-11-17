package gateway

import (
	"context"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
)

// Option configures a gateway Handler.
type Option func(*handlerConfig)

type handlerConfig struct {
	webDist string
	bindLAN bool
}

// WithWebDist enables built SPA hosting from webDist when non-empty.
func WithWebDist(dir string) Option {
	return func(c *handlerConfig) {
		c.webDist = strings.TrimSpace(dir)
	}
}

// WithBindLAN controls whether NewHandler attaches itself as st.LAN's upstream handler (default true).
func WithBindLAN(bind bool) Option {
	return func(c *handlerConfig) {
		c.bindLAN = bind
	}
}

type postHandler func(w http.ResponseWriter, r *http.Request, caller user.Caller)

// Handler serves the complete packages/protocol HTTP/SSE control plane, /mcp, /v1/chat/completions,
// binary media/attachment/artifact routes, and optional built SPA hosting.
type Handler struct {
	st      *stack.Stack
	hub     *gatewayHub
	webDist string
	posts   map[string]postHandler
}

var htmlTagRe = regexp.MustCompile(`(?i)<html[^>]*>`)

// NewHandler constructs the Layer 3 HTTP & SSE protocol gateway over st.
func NewHandler(st *stack.Stack, opts ...Option) *Handler {
	cfg := handlerConfig{bindLAN: true}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	h := &Handler{
		st:      st,
		hub:     newGatewayHub(st),
		webDist: cfg.webDist,
	}
	h.posts = h.buildPostRoutes()

	if cfg.bindLAN && st != nil && st.LAN != nil {
		st.SetLANUpstream(h)
	}
	return h
}

// StateFrame builds the current protocol StateFrame snapshot for state/SSE endpoints.
func (h *Handler) StateFrame(ctx context.Context) ProtoStateFrame {
	return h.hub.buildStateFrame(ctx)
}

// HandleState serves GET /api/v1/state (negotiating Accept: text/event-stream vs JSON snapshot).
func (h *Handler) HandleState(w http.ResponseWriter, r *http.Request) {
	if !isOriginAllowed(r) {
		writeError(w, newBizError(BizForbidden, "cross-origin API request rejected"), BizForbidden)
		return
	}
	h.handleStateStreamOrJSON(w, r)
}

// ServeHTTP dispatches all packages/protocol HTTP & SSE endpoints, binary routes, /mcp, and optional SPA fallback.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cleanPath := path.Clean("/" + r.URL.Path)

	// Loopback-only internal endpoints.
	if cleanPath == "/mcp" || strings.HasPrefix(cleanPath, "/mcp/") {
		caller := resolveCaller(h.st, r)
		if !caller.Here {
			writeError(w, newBizError(BizLanForbidden, "/mcp is loopback-only"), BizLanForbidden)
			return
		}
		if h.st == nil || h.st.MCP == nil {
			writeError(w, newBizError(BizServiceUnavailable, "mcp handler unavailable"), BizServiceUnavailable)
			return
		}
		h.st.MCP.ServeHTTP(w, r)
		return
	}

	if cleanPath == "/v1/chat/completions" {
		caller := resolveCaller(h.st, r)
		if !caller.Here {
			writeError(w, newBizError(BizLanForbidden, "/v1/chat/completions is loopback-only"), BizLanForbidden)
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
			return
		}
		if h.st == nil || h.st.Orchestrator == nil {
			writeError(w, newBizError(BizServiceUnavailable, "orchestrator unavailable"), BizServiceUnavailable)
			return
		}
		h.st.Orchestrator.ChatCompletionsOpenAI(w, r)
		return
	}

	if strings.HasPrefix(cleanPath, "/api/v1/") {
		if !isOriginAllowed(r) {
			writeError(w, newBizError(BizForbidden, "cross-origin API request rejected"), BizForbidden)
			return
		}
		h.serveAPIv1(w, r, cleanPath)
		return
	}

	if h.webDist != "" {
		h.serveSPA(w, r, cleanPath)
		return
	}
	writeError(w, newBizError(BizRouteNotFound, "route not found"), BizRouteNotFound)
}

func (h *Handler) serveAPIv1(w http.ResponseWriter, r *http.Request, cleanPath string) {
	switch cleanPath {
	case "/api/v1/state":
		h.handleStateStreamOrJSON(w, r)
		return
	case "/api/v1/live":
		h.handleLiveSSE(w, r)
		return
	case "/api/v1/events":
		h.handleEventsSSE(w, r)
		return
	}

	switch {
	case strings.HasPrefix(cleanPath, "/api/v1/attachment/") && r.Method != http.MethodPost:
		h.handleAttachmentGet(w, r)
		return
	case strings.HasPrefix(cleanPath, "/api/v1/artifact/") && r.Method != http.MethodPost:
		h.handleArtifactPreviewHTTP(w, r)
		return
	case strings.HasPrefix(cleanPath, "/api/v1/issue/watch/"):
		h.handleIssueWatchSSE(w, r)
		return
	case strings.HasPrefix(cleanPath, "/api/v1/subscribe/"):
		h.handleSubscribeSSE(w, r)
		return
	case strings.HasPrefix(cleanPath, "/api/v1/media/input/") && strings.HasSuffix(cleanPath, "/content"):
		h.handleMediaInputContent(w, r)
		return
	case strings.HasPrefix(cleanPath, "/api/v1/media/speech/") && strings.HasSuffix(cleanPath, "/stream"):
		h.handleMediaSpeechStream(w, r)
		return
	}

	if handler, ok := h.posts[cleanPath]; ok {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, newBizError(BizMethodNotAllowed, "POST required for "+cleanPath), BizMethodNotAllowed)
			return
		}
		caller := resolveCaller(h.st, r)
		handler(w, r, caller)
		return
	}

	writeError(w, newBizError(BizRouteNotFound, "unknown API route: "+cleanPath), BizRouteNotFound)
}

func (h *Handler) serveSPA(w http.ResponseWriter, r *http.Request, cleanPath string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
		return
	}
	if strings.Contains(r.URL.Path, "\x00") || strings.Contains(r.URL.Path, "\\") {
		writeError(w, newBizError(BizRouteNotFound, "not found"), BizRouteNotFound)
		return
	}

	rel := strings.TrimPrefix(cleanPath, "/")
	if rel == "" {
		rel = "index.html"
	}
	absDist, err := filepath.Abs(h.webDist)
	if err != nil {
		writeError(w, newBizError(BizNotFound, "not found"), BizNotFound)
		return
	}
	target := filepath.Join(absDist, filepath.FromSlash(rel))
	relCheck, relErr := filepath.Rel(absDist, target)
	if relErr != nil || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
		writeError(w, newBizError(BizRouteNotFound, "forbidden path"), BizRouteNotFound)
		return
	}

	if rel != "index.html" {
		if st, sErr := os.Stat(target); sErr == nil && !st.IsDir() {
			if strings.HasPrefix(cleanPath, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.ServeFile(w, r, target)
			return
		}
	}

	if filepath.Ext(cleanPath) == "" || rel == "index.html" {
		indexPath := filepath.Join(absDist, "index.html")
		raw, rErr := os.ReadFile(indexPath)
		if rErr != nil {
			writeError(w, newBizError(BizNotFound, "SPA index.html not found"), BizNotFound)
			return
		}
		locale := "zh"
		if h.st != nil && h.st.Setting != nil {
			if l := h.st.Setting.Get().Locale; l == "en" || l == "zh" {
				locale = l
			}
		}
		lang := "zh-Hans"
		if locale == "en" {
			lang = "en"
		}
		rewritten := htmlTagRe.ReplaceAllString(string(raw), `<html lang="`+lang+`" data-locale="`+locale+`">`)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write([]byte(rewritten))
		}
		return
	}
	writeError(w, newBizError(BizRouteNotFound, "asset not found"), BizRouteNotFound)
}

func (h *Handler) buildPostRoutes() map[string]postHandler {
	noCaller := func(fn http.HandlerFunc) postHandler {
		return func(w http.ResponseWriter, r *http.Request, _ user.Caller) { fn(w, r) }
	}
	return map[string]postHandler{
		// Core / server health
		"/api/v1/server/health/get": noCaller(h.handleHealthGet),

		// Settings & Providers
		"/api/v1/setting/get":         noCaller(h.handleSettingGet),
		"/api/v1/setting/validate":    noCaller(h.handleSettingValidate),
		"/api/v1/setting/update":      h.handleSettingUpdate,
		"/api/v1/provider/get":        h.handleProviderGet,
		"/api/v1/provider/update":     h.handleProviderUpdate,
		"/api/v1/provider/model/list": h.handleProviderModelList,
		"/api/v1/provider/voice/list": h.handleProviderVoiceList,

		// User, devices & approvals
		"/api/v1/user/get":                  h.handleUserGet,
		"/api/v1/user/update":               h.handleUserUpdate,
		"/api/v1/user/password/set":         h.handleUserPasswordSet,
		"/api/v1/user/login":                noCaller(h.handleUserLogin),
		"/api/v1/user/logout":               h.handleUserLogout,
		"/api/v1/user/device/list":          h.handleUserDeviceList,
		"/api/v1/user/device/delete":        h.handleUserDeviceDelete,
		"/api/v1/user/device/previewDelete": h.handleUserDevicePreviewDelete,
		"/api/v1/user/approval/create":      h.handleUserApprovalCreate,
		"/api/v1/user/approval/collect":     noCaller(h.handleUserApprovalCollect),
		"/api/v1/user/approval/list":        h.handleUserApprovalList,
		"/api/v1/user/approval/answer":      h.handleUserApprovalAnswer,

		// LAN pairing
		"/api/v1/lan/get":                 h.handleLanGet,
		"/api/v1/lan/update":              h.handleLanUpdate,
		"/api/v1/lan/pairing/start":       h.handleLanPairingStart,
		"/api/v1/lan/pairing/stop":        h.handleLanPairingStop,
		"/api/v1/lan/pairing/previewStop": h.handleLanPairingPreviewStop,
		"/api/v1/lan/pairing/answer":      h.handleLanPairingAnswer,
		"/api/v1/lan/pair":                noCaller(h.handleLanPair),

		// Attachments
		"/api/v1/attachment/create": noCaller(h.handleAttachmentCreate),

		// Connectors
		"/api/v1/connector/list":        noCaller(h.handleConnectorList),
		"/api/v1/connector/login":       h.handleConnectorLogin,
		"/api/v1/connector/verify":      h.handleConnectorVerify,
		"/api/v1/connector/logout":      h.handleConnectorLogout,
		"/api/v1/connector/channel/set": h.handleConnectorChannelSet,

		// Voice
		"/api/v1/voice/hear":         noCaller(h.handleVoiceHear),
		"/api/v1/voice/moss/verify":  h.handleVoiceMossVerify,
		"/api/v1/voice/grant/create": noCaller(h.handleVoiceGrantCreate),
		"/api/v1/voice/grant/renew":  noCaller(h.handleVoiceGrantRenew),
		"/api/v1/voice/call/start":   noCaller(h.handleVoiceCallStart),
		"/api/v1/voice/call/stop":    noCaller(h.handleVoiceCallStop),
		"/api/v1/voice/call/hear":    noCaller(h.handleVoiceCallHear),
		"/api/v1/voice/call/say":     noCaller(h.handleVoiceCallSay),
		"/api/v1/voice/dictate":      noCaller(h.handleVoiceDictate),

		// Repo & GitHub
		"/api/v1/repo/pr/submit":     h.handleRepoPRSubmit,
		"/api/v1/github/get":         noCaller(h.handleGithubGet),
		"/api/v1/github/refresh":     noCaller(h.handleGithubRefresh),
		"/api/v1/repo/list":          noCaller(h.handleRepoList),
		"/api/v1/repo/validate":      noCaller(h.handleRepoValidate),
		"/api/v1/repo/create":        noCaller(h.handleRepoCreate),
		"/api/v1/repo/language/list": noCaller(h.handleRepoLanguageList),
		"/api/v1/repo/template/list": noCaller(h.handleRepoTemplateList),
		"/api/v1/repo/activity/get":  noCaller(h.handleRepoActivityGet),

		// Agents, templates & skills
		"/api/v1/agent/list":                   noCaller(h.handleAgentList),
		"/api/v1/agent/validate":               noCaller(h.handleAgentValidate),
		"/api/v1/agent/create":                 h.handleAgentCreate,
		"/api/v1/agent/update":                 h.handleAgentUpdate,
		"/api/v1/agent/delete":                 h.handleAgentDelete,
		"/api/v1/agent/previewDelete":          h.handleAgentPreviewDelete,
		"/api/v1/agent/template/list":          noCaller(h.handleAgentTemplateList),
		"/api/v1/agent/template/install":       h.handleAgentTemplateInstall,
		"/api/v1/agent/template/update":        h.handleAgentTemplateUpdate,
		"/api/v1/agent/template/add":           h.handleAgentTemplateAdd,
		"/api/v1/agent/template/delete":        h.handleAgentTemplateDelete,
		"/api/v1/agent/template/previewDelete": h.handleAgentTemplatePreviewDelete,
		"/api/v1/skill/list":                   noCaller(h.handleSkillList),
		"/api/v1/skill/create": func(w http.ResponseWriter, r *http.Request, c user.Caller) {
			h.handleSkillSave(w, r, c, true)
		},
		"/api/v1/skill/update": func(w http.ResponseWriter, r *http.Request, c user.Caller) {
			h.handleSkillSave(w, r, c, false)
		},
		"/api/v1/skill/delete":        h.handleSkillDelete,
		"/api/v1/skill/previewDelete": h.handleSkillPreviewDelete,

		// Runtimes
		"/api/v1/runtime/list":           noCaller(h.handleRuntimeList),
		"/api/v1/runtime/refresh":        noCaller(h.handleRuntimeRefresh),
		"/api/v1/runtime/setting/update": h.handleRuntimeSettingUpdate,

		// Issues (plus CLI aliases)
		"/api/v1/issue/conversation/get":     noCaller(h.handleIssueConversationGet),
		"/api/v1/issue/comment/create":       noCaller(h.handleIssueCommentCreate),
		"/api/v1/issue/diff/get":             noCaller(h.handleIssueDiffGet),
		"/api/v1/issue/history/list":         noCaller(h.handleIssueHistoryList),
		"/api/v1/issue/list":                 noCaller(h.handleIssueList),
		"/api/v1/issue/review":               noCaller(h.handleIssueReview),
		"/api/v1/issue/split":                noCaller(h.handleIssueSplit),
		"/api/v1/issue/get":                  noCaller(h.handleIssueGet),
		"/api/v1/issue/run/list":             noCaller(h.handleIssueRunList),
		"/api/v1/issue/timeline/get":         noCaller(h.handleIssueTimelineGet),
		"/api/v1/issue/create":               noCaller(h.handleIssueCreate),
		"/api/v1/issue/update":               noCaller(h.handleIssueUpdate),
		"/api/v1/issue/delete":               noCaller(h.handleIssueDelete),
		"/api/v1/issue/previewDelete":        noCaller(h.handleIssuePreviewDelete),
		"/api/v1/issue/status/update":        noCaller(h.handleIssueStatusUpdate),
		"/api/v1/issue/status":               noCaller(h.handleIssueStatusUpdate),
		"/api/v1/issue/status/previewUpdate": noCaller(h.handleIssueStatusPreviewUpdate),
		"/api/v1/issue/refine":               noCaller(h.handleIssueRefine),

		// Sessions
		"/api/v1/session/stop":       noCaller(h.handleSessionStop),
		"/api/v1/session/list":       noCaller(h.handleSessionList),
		"/api/v1/session/get":        noCaller(h.handleSessionGet),
		"/api/v1/session/event/list": noCaller(h.handleSessionEventList),

		// Crons
		"/api/v1/cron/create":        noCaller(h.handleCronCreate),
		"/api/v1/cron/list":          noCaller(h.handleCronList),
		"/api/v1/cron/update":        noCaller(h.handleCronUpdate),
		"/api/v1/cron/delete":        noCaller(h.handleCronDelete),
		"/api/v1/cron/previewDelete": noCaller(h.handleCronPreviewDelete),

		// Orchestrator
		"/api/v1/orchestrator/open":        noCaller(h.handleOrchestratorOpen),
		"/api/v1/orchestrator/stop":        noCaller(h.handleOrchestratorStop),
		"/api/v1/orchestrator/eval/create": noCaller(h.handleOrchestratorEvalCreate),

		// Game
		"/api/v1/game/achievement/list": noCaller(h.handleGameAchievementList),
		"/api/v1/game/title/set":        noCaller(h.handleGameTitleSet),

		// Channels (plus CLI aliases)
		"/api/v1/channel/message/send":          noCaller(h.handleChannelMessageSend),
		"/api/v1/channel/send":                  noCaller(h.handleChannelMessageSend),
		"/api/v1/channel/create":                noCaller(h.handleChannelCreate),
		"/api/v1/channel/update":                noCaller(h.handleChannelUpdate),
		"/api/v1/channel/default/set":           noCaller(h.handleChannelDefaultSet),
		"/api/v1/channel/message/list":          noCaller(h.handleChannelMessageList),
		"/api/v1/channel/messages":              noCaller(h.handleChannelMessageList),
		"/api/v1/channel/markRead":              noCaller(h.handleChannelMarkRead),
		"/api/v1/channel/read":                  noCaller(h.handleChannelMarkRead),
		"/api/v1/channel/message/update":        noCaller(h.handleChannelMessageUpdate),
		"/api/v1/channel/message/delete":        noCaller(h.handleChannelMessageDelete),
		"/api/v1/channel/message/previewDelete": noCaller(h.handleChannelMessagePreviewDelete),
		"/api/v1/channel/message/search":        noCaller(h.handleChannelMessageSearch),
		"/api/v1/channel/reaction/set":          noCaller(h.handleChannelReactionSet),
		"/api/v1/channel/pin/set":               noCaller(h.handleChannelPinSet),
		"/api/v1/channel/pin/list":              noCaller(h.handleChannelPinList),
		"/api/v1/channel/thread/create":         noCaller(h.handleChannelThreadCreate),
		"/api/v1/channel/archive/set":           noCaller(h.handleChannelArchiveSet),
		"/api/v1/channel/delete":                noCaller(h.handleChannelDelete),
		"/api/v1/channel/previewDelete":         noCaller(h.handleChannelPreviewDelete),
		"/api/v1/channel/notify/set":            noCaller(h.handleChannelNotifySet),
		"/api/v1/channel/direct/create":         noCaller(h.handleChannelDirectCreate),
		"/api/v1/channel/markUnread":            noCaller(h.handleChannelMarkUnread),
		"/api/v1/channel/list":                  noCaller(h.handleChannelList),
		"/api/v1/channel/unread/list":           noCaller(h.handleChannelUnreadList),

		// Memory
		"/api/v1/memory/list":          noCaller(h.handleMemoryList),
		"/api/v1/memory/recall":        noCaller(h.handleMemoryRecall),
		"/api/v1/memory/create":        noCaller(h.handleMemoryCreate),
		"/api/v1/memory/search":        noCaller(h.handleMemorySearch),
		"/api/v1/memory/delete":        noCaller(h.handleMemoryDelete),
		"/api/v1/memory/previewDelete": noCaller(h.handleMemoryPreviewDelete),

		// PKM
		"/api/v1/pkm/page/list":       noCaller(h.handlePkmPageList),
		"/api/v1/pkm/list":            noCaller(h.handlePkmPageList),
		"/api/v1/pkm/page/get":        noCaller(h.handlePkmPageGet),
		"/api/v1/pkm/read":            noCaller(h.handlePkmPageGet),
		"/api/v1/pkm/page/save":       noCaller(h.handlePkmPageSave),
		"/api/v1/pkm/page/move":       noCaller(h.handlePkmPageMove),
		"/api/v1/pkm/page/rename":     noCaller(h.handlePkmPageRename),
		"/api/v1/pkm/page/export":     noCaller(h.handlePkmPageExport),
		"/api/v1/pkm/block/apply":     noCaller(h.handlePkmBlockApply),
		"/api/v1/pkm/search":          noCaller(h.handlePkmSearch),
		"/api/v1/pkm/capture":         noCaller(h.handlePkmCapture),
		"/api/v1/pkm/source/get":      noCaller(h.handlePkmSourceGet),
		"/api/v1/pkm/source/update":   noCaller(h.handlePkmSourceUpdate),
		"/api/v1/pkm/journal/open":    noCaller(h.handlePkmJournalOpen),
		"/api/v1/pkm/radar/get":       noCaller(h.handlePkmRadarGet),
		"/api/v1/pkm/comment/list":    noCaller(h.handlePkmCommentList),
		"/api/v1/pkm/comment/suggest": noCaller(h.handlePkmCommentSuggest),
		"/api/v1/pkm/comment/resolve": noCaller(h.handlePkmCommentResolve),
		"/api/v1/pkm/clip/create":     noCaller(h.handlePkmClipCreate),
		"/api/v1/pkm/cluster/create":  noCaller(h.handlePkmClusterCreate),
		"/api/v1/pkm/undo":            noCaller(h.handlePkmUndo),
		"/api/v1/pkm/scan":            noCaller(h.handlePkmScan),

		// Artifacts
		"/api/v1/artifact/list":                noCaller(h.handleArtifactList),
		"/api/v1/artifact/get":                 noCaller(h.handleArtifactGet),
		"/api/v1/artifact/content/get":         noCaller(h.handleArtifactContentGet),
		"/api/v1/artifact/create":              noCaller(h.handleArtifactCreate),
		"/api/v1/artifact/version/create":      noCaller(h.handleArtifactVersionCreate),
		"/api/v1/artifact/html/edit":           noCaller(h.handleArtifactHTMLEdit),
		"/api/v1/artifact/update":              noCaller(h.handleArtifactUpdate),
		"/api/v1/artifact/delete":              noCaller(h.handleArtifactDelete),
		"/api/v1/artifact/previewDelete":       noCaller(h.handleArtifactPreviewDelete),
		"/api/v1/artifact/block/list":          noCaller(h.handleArtifactBlockList),
		"/api/v1/artifact/submit":              noCaller(h.handleArtifactSubmit),
		"/api/v1/artifact/block/create":        noCaller(h.handleArtifactBlockCreate),
		"/api/v1/artifact/block/update":        noCaller(h.handleArtifactBlockUpdate),
		"/api/v1/artifact/block/delete":        noCaller(h.handleArtifactBlockDelete),
		"/api/v1/artifact/block/previewDelete": noCaller(h.handleArtifactBlockPreviewDelete),
		"/api/v1/artifact/suggestion/list":     noCaller(h.handleArtifactSuggestionList),
		"/api/v1/artifact/suggestion/create":   noCaller(h.handleArtifactSuggestionCreate),
		"/api/v1/artifact/suggestion/accept":   noCaller(h.handleArtifactSuggestionAccept),
		"/api/v1/artifact/suggestion/reject":   noCaller(h.handleArtifactSuggestionReject),
		"/api/v1/artifact/markdown/get":        noCaller(h.handleArtifactMarkdownGet),
		"/api/v1/artifact/demo":                noCaller(h.handleArtifactDemo),

		// Media & Library
		"/api/v1/media/dialogue/create":              noCaller(h.handleMediaAudioCreate("speakers")),
		"/api/v1/media/voiceDesign/create":           noCaller(h.handleMediaAudioCreate("voiceDesign")),
		"/api/v1/media/clone/create":                 noCaller(h.handleMediaAudioCreate("clone")),
		"/api/v1/media/transcription/create":         noCaller(h.handleMediaAudioCreate("transcription")),
		"/api/v1/media/audio/resume":                 noCaller(h.handleMediaJobAction("resume")),
		"/api/v1/media/audio/previewCleanup":         noCaller(h.handleMediaPreviewAction("Clean up audio job")),
		"/api/v1/media/audio/cleanup":                noCaller(h.handleMediaJobAction("cleanup")),
		"/api/v1/media/input/create":                 h.handleMediaInputCreate,
		"/api/v1/media/input/adopt":                  h.handleMediaInputAdopt,
		"/api/v1/media/input/get":                    h.handleMediaInputGet,
		"/api/v1/media/input/list":                   h.handleMediaInputList,
		"/api/v1/media/input/previewDelete":          h.handleMediaInputPreviewDelete,
		"/api/v1/media/input/delete":                 h.handleMediaInputDelete,
		"/api/v1/media/image/create":                 noCaller(h.handleMediaImageCreate),
		"/api/v1/media/understanding/create":         noCaller(h.handleMediaUnderstandingCreate),
		"/api/v1/media/understanding/authorize":      noCaller(h.handleMediaUnderstandingCreate),
		"/api/v1/media/understanding/start":          noCaller(h.handleMediaJobAction("start")),
		"/api/v1/media/speech/create":                noCaller(h.handleMediaSpeechCreate),
		"/api/v1/media/speech/resume":                noCaller(h.handleMediaJobAction("resume")),
		"/api/v1/media/understanding/previewCleanup": noCaller(h.handleMediaPreviewAction("Clean up understanding job")),
		"/api/v1/media/understanding/cleanup":        noCaller(h.handleMediaJobAction("cleanup")),
		"/api/v1/media/job/get":                      noCaller(h.handleMediaJobAction("get")),
		"/api/v1/media/job/cancel":                   noCaller(h.handleMediaJobAction("cancel")),
		"/api/v1/media/job/previewRelease":           noCaller(h.handleMediaPreviewAction("Release media job")),
		"/api/v1/media/job/release":                  noCaller(h.handleMediaJobAction("release")),
		"/api/v1/media/job/download":                 noCaller(h.handleMediaJobAction("download")),
		"/api/v1/media/job/list":                     noCaller(h.handleMediaJobList),
		"/api/v1/library/item/list":                  noCaller(h.handleLibraryItemList),
		"/api/v1/library/item/add":                   h.handleLibraryItemAdd,
		"/api/v1/library/item/delete":                noCaller(h.handleLibraryItemDelete),
		"/api/v1/library/item/previewDelete":         noCaller(h.handleLibraryItemPreviewDelete),
	}
}
