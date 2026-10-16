package claude

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func modelText(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

// ProjectClaudeModels projects the list_models control response
// (projectClaudeModels). value is the selector the session accepts (an alias
// such as sonnet or a concrete ID); resolvedModel is what that alias means
// today. A disabled entry is still listed because claude shows it, with its
// description as the reason (typically a required CLI upgrade).
func ProjectClaudeModels(payload any) []oar.ModelEntry {
	entries := []oar.ModelEntry{}
	for _, model := range jsonx.AsRecordList(jsonx.AsRecord(payload)["models"]) {
		id := modelText(model["value"])
		if id == "" {
			continue
		}
		entry := oar.ModelEntry{
			ID:           id,
			ResolvedID:   modelText(model["resolvedModel"]),
			DisplayName:  modelText(model["displayName"]),
			EffortLevels: shared.EffortLevelsOf(model["supportedEffortLevels"]),
		}
		if model["supportsFastMode"] == true {
			entry.ServiceTiers = []string{"fast"}
		}
		if model["disabled"] == true {
			reason := modelText(model["description"])
			if reason == "" {
				reason = "disabled by claude"
			}
			entry.Disabled = &oar.ModelDisabled{Reason: reason}
		}
		entries = append(entries, entry)
	}
	return entries
}

func controlError(inner jsonx.Record) string {
	if text := modelText(inner["error"]); text != "" {
		return text
	}
	if text := modelText(inner["message"]); text != "" {
		return text
	}
	return "claude rejected the list_models control request"
}

var unauthenticatedDetail = regexp.MustCompile(`(?i)log(?:ged)? ?in|auth|api key`)

type listOutcome struct {
	kind    string
	payload any
	detail  string
}

// readListModels asks claude list_models on the stream-json control channel
// before any turn runs, so it costs no tokens. --verbose is mandatory for
// stream-json output in print mode. Matching is by request_id; other control
// traffic (hooks, permission prompts) is ignored.
func readListModels(ctx context.Context, command, cwd string, timeout time.Duration) (listOutcome, error) {
	child, err := spawnLineProcess(command, []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
	}, executable.LineOptions{Dir: cwd, Env: claudeEnv(), KillTree: true})
	if err != nil {
		return listOutcome{}, err
	}
	requestID := "oar-list-models-" + observe.NewUUID()
	answered := make(chan jsonx.Record, 1)
	answer := func(inner jsonx.Record) {
		select {
		case answered <- inner:
		default:
		}
	}
	child.OnLine(func(line string) {
		message := jsonx.ParseRecord([]byte(line))
		if message["type"] != "control_response" {
			return
		}
		if inner := jsonx.AsRecord(message["response"]); inner != nil && inner["request_id"] == requestID {
			answer(inner)
		}
	})
	child.OnExit(func(*int) { answer(nil) })
	timer := time.AfterFunc(timeout, child.Kill)
	defer func() {
		timer.Stop()
		child.Kill()
		<-child.Exited()
	}()
	child.Write(jsonText(controlRequest{Type: "control_request", RequestID: requestID, Request: map[string]any{"subtype": "list_models"}}) + "\n")
	var inner jsonx.Record
	select {
	case inner = <-answered:
	case <-ctx.Done():
		return listOutcome{}, ctx.Err()
	}
	if inner == nil {
		return listOutcome{kind: "error", detail: "claude exited before answering list_models"}, nil
	}
	if inner["subtype"] == "success" {
		return listOutcome{kind: "ok", payload: inner["response"]}, nil
	}
	detail := controlError(inner)
	if unauthenticatedDetail.MatchString(detail) {
		return listOutcome{kind: "unauthenticated", detail: detail}, nil
	}
	return listOutcome{kind: "error", detail: detail}, nil
}

// ListModels lists the models claude accepts (claudeListModels).
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if installation.Via != "executable" {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "claude model listing requires the claude executable"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	outcome, err := readListModels(ctx, installation.Command, shared.ListingCwd(options), timeout)
	if err != nil {
		return oar.ListModelsResult{}, errors.New("Failed to list Claude models: " + err.Error())
	}
	switch outcome.kind {
	case "ok":
		return oar.ListModelsResult{Kind: "ok", Models: ProjectClaudeModels(outcome.payload)}, nil
	case "unauthenticated":
		return oar.ListModelsResult{Kind: "unauthenticated", Detail: outcome.detail}, nil
	}
	return oar.ListModelsResult{}, errors.New("Failed to list Claude models: " + outcome.detail)
}
