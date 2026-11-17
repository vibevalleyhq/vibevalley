package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/attachment"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/connector"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/lan"
	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	"github.com/vibevalleyhq/vibevalley/internal/domain/setting"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
	"github.com/vibevalleyhq/vibevalley/internal/domain/voice"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const defaultMaxJSONBodyBytes = 32 * 1024 * 1024

// Business error codes matching packages/protocol/src/endpoint.ts BizCode.
const (
	BizOk                   = 0
	BizInvalidInput         = 100001
	BizPayloadTooLarge      = 100002
	BizUnsupportedMediaType = 100003
	BizMethodNotAllowed     = 100004
	BizRouteNotFound        = 100005
	BizRequestKeyTooLong    = 100006
	BizInternalError        = 100007
	BizBadGateway           = 100008
	BizServiceUnavailable   = 100009
	BizNotFound             = 100010
	BizRefused              = 100011

	BizUnauthorized   = 200001
	BizForbidden      = 200002
	BizAuthRefused    = 200003
	BizUserNotFound   = 200004
	BizLanForbidden   = 200005
	BizLanUnavailable = 200006

	BizIssueNotFound = 300001
	BizIssueRefused  = 300002
	BizRepoNotFound  = 300003
	BizRepoRefused   = 300004

	BizSessionNotFound      = 400001
	BizSessionRefused       = 400002
	BizAgentNotFound        = 400003
	BizAgentRefused         = 400004
	BizRuntimeNotFound      = 400005
	BizRuntimeRefused       = 400006
	BizOrchestratorRefused  = 400007
	BizOrchestratorNotFound = 400008

	BizChannelNotFound  = 500001
	BizChannelRefused   = 500002
	BizConnectorRefused = 500003
	BizCronNotFound     = 500004
	BizCronRefused      = 500005
	BizGameRefused      = 500006

	BizArtifactNotFound  = 600001
	BizArtifactRefused   = 600002
	BizPkmNotFound       = 600003
	BizPkmRefused        = 600004
	BizMemoryNotFound    = 600005
	BizMemoryRefused     = 600006
	BizLibraryNotFound   = 600007
	BizLibraryRefused    = 600008
	BizAttachmentRefused = 600009

	BizVoiceUnavailable = 700001
	BizVoiceCallFailed  = 700002
	BizVoiceRefused     = 700003
	BizMediaNotFound    = 700004
	BizMediaRefused     = 700005
	BizProviderRefused  = 700006
	BizSettingRefused   = 700007
)

// NextAction matches packages/protocol/src/endpoint.ts Next.
type NextAction struct {
	Say string   `json:"say"`
	Run []string `json:"run,omitempty"`
}

// ErrorDetail matches packages/protocol/src/endpoint.ts ApiErrorDetail.
type ErrorDetail struct {
	Next     []NextAction `json:"next,omitempty"`
	Settings string       `json:"settings,omitempty"`
}

// ErrorEnvelope matches packages/protocol/src/endpoint.ts ApiErrorEnvelope.
type ErrorEnvelope struct {
	BizCode int          `json:"bizCode"`
	Message string       `json:"message"`
	Error   *ErrorDetail `json:"error,omitempty"`
}

// BizError represents an explicit protocol business refusal mapped to an HTTP status and BizCode.
type BizError struct {
	Code     int
	Message  string
	Settings string
	Next     []NextAction
}

func (e *BizError) Error() string {
	return e.Message
}

func newBizError(code int, msg string) *BizError {
	return &BizError{Code: code, Message: msg}
}

func httpStatusForBizCode(code int) int {
	switch code {
	case BizInvalidInput:
		return http.StatusBadRequest
	case BizPayloadTooLarge:
		return http.StatusRequestEntityTooLarge
	case BizUnsupportedMediaType:
		return http.StatusUnsupportedMediaType
	case BizMethodNotAllowed:
		return http.StatusMethodNotAllowed
	case BizRouteNotFound, BizNotFound, BizUserNotFound,
		BizIssueNotFound, BizRepoNotFound,
		BizSessionNotFound, BizAgentNotFound, BizRuntimeNotFound, BizOrchestratorNotFound,
		BizChannelNotFound, BizCronNotFound,
		BizArtifactNotFound, BizPkmNotFound, BizMemoryNotFound, BizLibraryNotFound,
		BizMediaNotFound:
		return http.StatusNotFound
	case BizRequestKeyTooLong:
		return http.StatusConflict
	case BizInternalError:
		return http.StatusInternalServerError
	case BizBadGateway, BizVoiceCallFailed:
		return http.StatusBadGateway
	case BizServiceUnavailable, BizLanUnavailable, BizVoiceUnavailable:
		return http.StatusServiceUnavailable
	case BizUnauthorized:
		return http.StatusUnauthorized
	case BizForbidden, BizAuthRefused, BizLanForbidden:
		return http.StatusForbidden
	default:
		return http.StatusConflict
	}
}

func writeJSONRaw(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		body = []byte(`{"bizCode":100007,"message":"internal JSON marshal error"}`)
		status = http.StatusInternalServerError
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeSuccess(w http.ResponseWriter, data any) {
	writeJSONRaw(w, http.StatusOK, struct {
		BizCode int    `json:"bizCode"`
		Message string `json:"message"`
		Data    any    `json:"data"`
	}{
		BizCode: BizOk,
		Message: "ok",
		Data:    data,
	})
}

func writeVoid(w http.ResponseWriter) {
	writeJSONRaw(w, http.StatusOK, struct {
		BizCode int    `json:"bizCode"`
		Message string `json:"message"`
	}{
		BizCode: BizOk,
		Message: "ok",
	})
}

func writeBizError(w http.ResponseWriter, be *BizError) {
	if be == nil {
		be = newBizError(BizInternalError, "internal error")
	}
	var detail *ErrorDetail
	if be.Settings != "" || len(be.Next) > 0 {
		detail = &ErrorDetail{
			Next:     be.Next,
			Settings: be.Settings,
		}
	}
	msg := strings.TrimSpace(be.Message)
	if msg == "" {
		msg = "request failed"
	}
	writeJSONRaw(w, httpStatusForBizCode(be.Code), ErrorEnvelope{
		BizCode: be.Code,
		Message: msg,
		Error:   detail,
	})
}

func writeError(w http.ResponseWriter, err error, fallbackCode int) {
	if err == nil {
		return
	}
	var be *BizError
	if errors.As(err, &be) {
		writeBizError(w, be)
		return
	}
	mapped := mapDomainError(err, fallbackCode)
	writeBizError(w, mapped)
}

func mapDomainError(err error, fallbackCode int) *BizError {
	if fallbackCode == 0 {
		fallbackCode = BizInternalError
	}
	switch {
	case errors.Is(err, lan.ErrUnauthorized):
		return newBizError(BizUnauthorized, err.Error())
	case errors.Is(err, user.ErrAuthRefused):
		return newBizError(BizAuthRefused, err.Error())
	case errors.Is(err, user.ErrDeviceNotFound), errors.Is(err, user.ErrApprovalGone):
		return newBizError(BizUserNotFound, err.Error())
	case errors.Is(err, lan.ErrLanForbidden):
		return newBizError(BizLanForbidden, err.Error())
	case errors.Is(err, lan.ErrLanUnavailable):
		return newBizError(BizLanUnavailable, err.Error())
	case errors.Is(err, setting.ErrSettingRefused):
		return newBizError(BizSettingRefused, err.Error())
	case errors.Is(err, setting.ErrProviderRefused):
		return newBizError(BizProviderRefused, err.Error())
	case errors.Is(err, connector.ErrConnectorRefused):
		return newBizError(BizConnectorRefused, err.Error())
	case errors.Is(err, voice.ErrVoiceUnavailable):
		be := newBizError(BizVoiceUnavailable, err.Error())
		be.Settings = "call"
		return be
	case errors.Is(err, voice.ErrVoiceCallFailed):
		return newBizError(BizVoiceCallFailed, err.Error())
	case errors.Is(err, voice.ErrVoiceRefused):
		return newBizError(BizVoiceRefused, err.Error())
	case errors.Is(err, attachment.ErrTooLarge):
		return newBizError(BizPayloadTooLarge, err.Error())
	case errors.Is(err, attachment.ErrInvalidInput), errors.Is(err, attachment.ErrInvalidSHA256), errors.Is(err, attachment.ErrEmpty):
		return newBizError(BizInvalidInput, err.Error())
	case errors.Is(err, attachment.ErrNotFound):
		return newBizError(BizNotFound, err.Error())
	case errors.Is(err, issue.ErrNotFound):
		return newBizError(BizIssueNotFound, err.Error())
	case errors.Is(err, issue.ErrInvalidArgument), errors.Is(err, issue.ErrInvalidTransition), errors.Is(err, issue.ErrInvalidCronSchedule):
		return newBizError(BizIssueRefused, err.Error())
	case errors.Is(err, repo.ErrNotFound):
		return newBizError(BizRepoNotFound, err.Error())
	case errors.Is(err, repo.ErrInvalidArgument), errors.Is(err, repo.ErrInvalidRepoName), errors.Is(err, repo.ErrDuplicate),
		errors.Is(err, repo.ErrDirtyWorktree), errors.Is(err, repo.ErrMergeConflict), errors.Is(err, repo.ErrSymlinkEscape):
		return newBizError(BizRepoRefused, err.Error())
	case errors.Is(err, agent.ErrNotFound):
		return newBizError(BizAgentNotFound, err.Error())
	case errors.Is(err, agent.ErrInvalidArgument), errors.Is(err, agent.ErrProtectedOrchestrator), errors.Is(err, agent.ErrBuiltInReadOnly):
		return newBizError(BizAgentRefused, err.Error())
	case errors.Is(err, channel.ErrNotFound):
		return newBizError(BizChannelNotFound, err.Error())
	case errors.Is(err, channel.ErrInvalidArgument), errors.Is(err, channel.ErrInvalidEventKind), errors.Is(err, channel.ErrDuplicateChannel):
		return newBizError(BizChannelRefused, err.Error())
	case errors.Is(err, artifact.ErrNotFound), errors.Is(err, artifact.ErrBlobNotFound), errors.Is(err, artifact.ErrVersionNotFound):
		return newBizError(BizArtifactNotFound, err.Error())
	case errors.Is(err, artifact.ErrInvalidBundle), errors.Is(err, artifact.ErrInvalidBlockOp), errors.Is(err, artifact.ErrInvalidOrderKey),
		errors.Is(err, artifact.ErrConflict), errors.Is(err, artifact.ErrStaleSuggestion), errors.Is(err, artifact.ErrSuggestionNotFound),
		errors.Is(err, artifact.ErrSuggestionConflict), errors.Is(err, artifact.ErrInvalidDisplayMode), errors.Is(err, artifact.ErrHTMLPolicyViolation):
		return newBizError(BizArtifactRefused, err.Error())
	case errors.Is(err, pkm.ErrNotFound):
		return newBizError(BizPkmNotFound, err.Error())
	case errors.Is(err, pkm.ErrInvalidArgument), errors.Is(err, pkm.ErrInvalidPath):
		return newBizError(BizPkmRefused, err.Error())
	case errors.Is(err, memory.ErrNotFound):
		return newBizError(BizMemoryNotFound, err.Error())
	case errors.Is(err, memory.ErrInvalidArgument), errors.Is(err, memory.ErrConflict), errors.Is(err, memory.ErrInvalidTransition):
		return newBizError(BizMemoryRefused, err.Error())
	case errors.Is(err, media.ErrAssetNotFound):
		return newBizError(BizMediaNotFound, err.Error())
	case errors.Is(err, media.ErrInvalidSHA256), errors.Is(err, media.ErrAssetTooLarge), errors.Is(err, media.ErrInvalidDisplay):
		return newBizError(BizMediaRefused, err.Error())
	case errors.Is(err, store.ErrNotFound):
		if fallbackCode != BizInternalError {
			return newBizError(fallbackCode, err.Error())
		}
		return newBizError(BizNotFound, err.Error())
	case errors.Is(err, stack.ErrClosed):
		return newBizError(BizServiceUnavailable, err.Error())
	default:
		return newBizError(fallbackCode, err.Error())
	}
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, required bool) error {
	if r.Body == nil {
		if required {
			return newBizError(BizInvalidInput, "request body is required")
		}
		return nil
	}
	limited := http.MaxBytesReader(w, r.Body, defaultMaxJSONBodyBytes)
	raw, err := io.ReadAll(limited)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return newBizError(BizPayloadTooLarge, fmt.Sprintf("request body exceeds %d bytes", defaultMaxJSONBodyBytes))
		}
		return newBizError(BizInvalidInput, fmt.Sprintf("read body: %v", err))
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		if required {
			return newBizError(BizInvalidInput, "request body must be non-empty JSON")
		}
		return nil
	}
	if err := json.Unmarshal(trimmed, dst); err != nil {
		return newBizError(BizInvalidInput, fmt.Sprintf("invalid JSON body: %v", err))
	}
	return nil
}

func checkRequestKeyLength(key string) error {
	if len(key) > 128 {
		return newBizError(BizRequestKeyTooLong, "requestKey exceeds 128 characters")
	}
	return nil
}
