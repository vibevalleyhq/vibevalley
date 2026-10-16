package claude

import (
	"context"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

const (
	hourMs = int64(3_600_000)
	weekMs = 7 * 24 * hourMs
)

// runExecutable runs a one-shot command; tests replace it (TS: vi.mock of runExecutable).
var runExecutable = executable.Run

// windowKey is the native key and, where the key names it, the window's length.
type windowKey struct {
	id         string
	durationMs *int64
}

func parseInstant(text string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05", "2006-01-02"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func windowOf(label string, value any, key *windowKey) *oar.AccountUsageWindow {
	entry := jsonx.AsRecord(value)
	percent, ok := jsonx.Num(entry, "utilization")
	if !ok || percent < 0 {
		return nil
	}
	// Number((percent / 100).toFixed(6))
	ratio, _ := strconv.ParseFloat(strconv.FormatFloat(percent/100, 'f', 6, 64), 64)
	window := &oar.AccountUsageWindow{Label: label, UsedRatio: math.Min(1, ratio)}
	if reset, ok := entry["resets_at"].(string); ok {
		if parsed, ok := parseInstant(reset); ok {
			window.ResetsAt = shared.UtcInstantFromDate(parsed)
		}
	}
	if key != nil {
		window.ID = key.id
		window.DurationMs = key.durationMs
	}
	return window
}

func durationOf(ms int64) *int64 { return &ms }

// ProjectClaudeUsage reads the native get_usage reply, not the HTTP
// endpoint's unrelated limits[] shape (projectClaudeUsage). email "" is none.
func ProjectClaudeUsage(payload any, email string) (oar.AccountUsageSnapshot, error) {
	root := jsonx.AsRecord(payload)
	if root["rate_limits_available"] == false {
		// The CLI does not distinguish auth mode, missing scope, etc. here.
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "quota_unavailable"}, nil
	}
	if root["rate_limits_available"] != true {
		return oar.AccountUsageSnapshot{}, errors.New("Claude get_usage returned an invalid availability flag")
	}
	limits := jsonx.AsRecord(root["rate_limits"])
	if limits == nil {
		// Available in principle, but the runtime could not supply a snapshot.
		return oar.AccountUsageSnapshot{}, errors.New("Claude get_usage did not return account rate limits")
	}
	windows := []oar.AccountUsageWindow{}
	add := func(label string, value any, key windowKey) {
		if window := windowOf(label, value, &key); window != nil {
			windows = append(windows, *window)
		}
	}
	add("Current session", limits["five_hour"], windowKey{"five_hour", durationOf(5 * hourMs)})
	add("Current week (all models)", limits["seven_day"], windowKey{"seven_day", durationOf(weekMs)})
	add("Current week (OAuth apps)", limits["seven_day_oauth_apps"], windowKey{"seven_day_oauth_apps", durationOf(weekMs)})
	if _, ok := limits["model_scoped"].([]any); ok {
		for _, entry := range jsonx.AsRecordList(limits["model_scoped"]) {
			if name, ok := entry["display_name"].(string); ok && strings.TrimSpace(name) != "" {
				// A scoped entry names its model only by display name (2.1.288: scope.model.id is null).
				add("Current week ("+name+")", entry, windowKey{"model_scoped:" + name, durationOf(weekMs)})
			}
		}
	} else {
		add("Current week (Opus)", limits["seven_day_opus"], windowKey{"seven_day_opus", durationOf(weekMs)})
		add("Current week (Sonnet)", limits["seven_day_sonnet"], windowKey{"seven_day_sonnet", durationOf(weekMs)})
	}
	includedExhausted := false
	for _, window := range windows {
		if window.UsedRatio >= 1 {
			includedExhausted = true
		}
	}
	extra := jsonx.AsRecord(limits["extra_usage"])
	var extraWindow *oar.AccountUsageWindow
	if extra["is_enabled"] == true {
		extraWindow = windowOf("Extra usage", extra, &windowKey{id: "extra_usage"})
	}
	if extraWindow != nil {
		windows = append(windows, *extraWindow)
	}
	if len(windows) == 0 {
		return oar.AccountUsageSnapshot{}, errors.New("Claude get_usage returned no usable windows")
	}
	plan, _ := root["subscription_type"].(string)
	return oar.AccountUsageSnapshot{
		Kind:        "available",
		Plan:        strings.TrimSpace(plan),
		Email:       email,
		RateLimited: includedExhausted && !(extraWindow != nil && extraWindow.UsedRatio < 1),
		Windows:     windows,
	}, nil
}

var (
	endpointUnavailable = regexp.MustCompile(`(?i)unsupported control request subtype|unknown control request|not supported in this context|not available on this connection`)
	notAuthenticated    = regexp.MustCompile(`(?i)not logged in|authentication required|please (?:run )?/login`)
)

func controlFailure(reply jsonx.Record) (oar.AccountUsageSnapshot, error) {
	detail, ok := reply["error"].(string)
	if !ok {
		detail = "Malformed control response"
	}
	if endpointUnavailable.MatchString(detail) {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "endpoint_unavailable"}, nil
	}
	if notAuthenticated.MatchString(detail) {
		return oar.AccountUsageSnapshot{Kind: "reauth_required", Reason: "not_authenticated"}, nil
	}
	return oar.AccountUsageSnapshot{}, errors.New("Claude usage control request failed: " + detail)
}

// A usage read must not run the user's hooks or start their MCP servers, so
// the query process runs with --safe-mode. A CLI that lacks the flag is
// reported as unsupported rather than launched without isolation. A help
// probe that timed out or never ran is an operational failure, like the
// query's own timeout. Only a successful help probe is cached, so a failed
// one is retried on the next read.
const usageName = "Claude account usage"

var (
	safeModeMu      sync.Mutex
	safeModeSupport = map[string]bool{}
	safeModeFlag    = regexp.MustCompile(`(?:^|\s)--safe-mode\b`)
)

func supportsSafeMode(ctx context.Context, command, version string, deadline time.Time) (bool, error) {
	key := command + "\x00" + version
	safeModeMu.Lock()
	known, ok := safeModeSupport[key]
	safeModeMu.Unlock()
	if ok {
		return known, nil
	}
	remaining, err := shared.Remaining(deadline, usageName)
	if err != nil {
		return false, err
	}
	help := runExecutable(ctx, command, []string{"--help"}, executable.RunOptions{Env: claudeEnv(), Timeout: remaining.Truncate(time.Millisecond) + time.Millisecond})
	if err := executable.AssertRan(help, "Failed to run "+command+" --help"); err != nil {
		return false, err
	}
	if !help.OK {
		return false, nil
	}
	supported := safeModeFlag.MatchString(help.Stdout)
	safeModeMu.Lock()
	safeModeSupport[key] = supported
	safeModeMu.Unlock()
	return supported, nil
}

// AccountUsage reads claude's account limits (claudeAccountUsage). Only
// native control queries; no prompt, credential reads or direct HTTP.
// Fresh-process session totals are deliberately not exposed as account
// usage. initialize provides optional account identity; get_usage owns quota access.
func AccountUsage(ctx context.Context, installation oar.AvailableInstallation, options oar.AccountUsageReadOptions) (oar.AccountUsageSnapshot, error) {
	if installation.Via != "executable" {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "unsupported_installation"}, nil
	}
	// One budget for the whole read, shared by the help probe and the query:
	// two claude starts, each of which a slow launcher can stretch.
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	supported, err := supportsSafeMode(ctx, installation.Command, installation.Version, deadline)
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	if !supported {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "unsupported_installation"}, nil
	}
	queryTimeout, err := shared.Remaining(deadline, usageName)
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	child, err := spawnLineProcess(installation.Command, []string{
		"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--no-session-persistence", "--safe-mode",
	}, executable.LineOptions{Env: claudeEnv(), KillTree: true})
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	var mu sync.Mutex
	type pendingQuery struct {
		id    string
		reply chan jsonx.Record
	}
	var pending *pendingQuery
	ended, timedOut := false, false
	resolve := func(reply jsonx.Record) {
		if pending != nil {
			select {
			case pending.reply <- reply:
			default:
			}
		}
	}
	child.OnLine(func(line string) {
		message := jsonx.ParseRecord([]byte(line))
		inner := jsonx.AsRecord(message["response"])
		mu.Lock()
		defer mu.Unlock()
		if message["type"] == "control_response" && pending != nil && inner != nil && inner["request_id"] == pending.id {
			resolve(inner)
		}
	})
	child.OnExit(func(*int) {
		mu.Lock()
		defer mu.Unlock()
		ended = true
		resolve(nil)
	})
	timer := time.AfterFunc(queryTimeout, func() {
		mu.Lock()
		timedOut = true
		resolve(nil)
		mu.Unlock()
		child.Kill()
	})
	defer func() {
		timer.Stop()
		child.Kill()
		<-child.Exited()
	}()
	query := func(request map[string]any) (jsonx.Record, error) {
		mu.Lock()
		if ended || timedOut {
			mu.Unlock()
			return nil, errors.New("Claude exited or timed out before answering usage queries")
		}
		query := &pendingQuery{id: "oar-usage-" + observe.NewUUID(), reply: make(chan jsonx.Record, 1)}
		pending = query
		child.Write(jsonText(controlRequest{Type: "control_request", RequestID: query.id, Request: request}) + "\n")
		mu.Unlock()
		var reply jsonx.Record
		select {
		case reply = <-query.reply:
		case <-ctx.Done():
		}
		mu.Lock()
		pending = nil
		mu.Unlock()
		if reply == nil {
			return nil, errors.New("Claude exited or timed out before answering usage query")
		}
		return reply, nil
	}
	initialized, err := query(map[string]any{"subtype": "initialize"})
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	if initialized["subtype"] != "success" {
		return controlFailure(initialized)
	}
	email := ""
	if account := jsonx.AsRecord(jsonx.AsRecord(initialized["response"])["account"]); account != nil {
		if text, ok := account["email"].(string); ok {
			email = strings.TrimSpace(text)
		}
	}
	reply, err := query(map[string]any{"subtype": "get_usage", "skip_behaviors": true})
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	if reply["subtype"] != "success" {
		return controlFailure(reply)
	}
	return ProjectClaudeUsage(reply["response"], email)
}
