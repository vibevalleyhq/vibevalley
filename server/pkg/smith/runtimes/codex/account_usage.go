package codex

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// codex's account usage (account-usage.ts): `account/rateLimits/read` on its own app-server.

const defaultAccountUsageTimeout = 8 * time.Second

// readOutcome is "ok" (result, email), "reauth_required" (reason),
// "unsupported" (reason) or "error".
type readOutcome struct {
	kind   string
	result json.RawMessage
	email  string
	reason string
}

// startAccountClient starts the app-server an account read talks to; tests replace it.
type startAccountClient func(command string) appServerClient

func defaultAccountClient(command string) appServerClient {
	return startAppServerClient(command, nil, nil, "", appServerProcessOptions{})
}

func usageText(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(text)
	return trimmed, trimmed != "" && utf16Len(trimmed) <= 80
}

func utf16Len(text string) int {
	count := 0
	for _, r := range text {
		if r > 0xFFFF {
			count += 2
		} else {
			count++
		}
	}
	return count
}

func windowLabel(value any) string {
	minutes, ok := jsonx.AsNumber(value)
	if !ok || minutes <= 0 {
		return "Usage limit"
	}
	unit := func(count float64, one, many string) string {
		if count == 1 {
			return jsString(count) + " " + one
		}
		return jsString(count) + " " + many
	}
	const week, day = 7 * 24 * 60, 24 * 60
	if jsMod(minutes, week) == 0 {
		return unit(minutes/week, "week", "weeks")
	}
	if jsMod(minutes, day) == 0 {
		return unit(minutes/day, "day", "days")
	}
	if jsMod(minutes, 60) == 0 {
		return unit(minutes/60, "hour", "hours")
	}
	return jsString(minutes) + " minutes"
}

func jsMod(value, by float64) float64 {
	return value - by*float64(int64(value/by))
}

func limitLabel(bucket jsonx.Record) (string, bool) {
	if name, ok := usageText(bucket["limitName"]); ok {
		return name, true
	}
	id, ok := usageText(bucket["limitId"])
	if id == "codex" {
		return "Codex", true
	}
	return id, ok
}

// rateLimitBuckets mirrors Codex TUI's `app_server_rate_limit_snapshots`
// merge and deduplication. Source (2026-08-22):
// https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/tui/src/app_server_session.rs#L2084-L2103
// indexedOrder is the wire order of rateLimitsByLimitId's keys.
func rateLimitBuckets(historical, indexed jsonx.Record, indexedOrder []string) []jsonx.Record {
	primaryLimitID, hasPrimary := usageText(historical["limitId"])
	buckets := []jsonx.Record{}
	if historical != nil {
		buckets = append(buckets, historical)
	}
	if indexed == nil {
		return buckets
	}
	for _, limitID := range indexedOrder {
		bucket := jsonx.AsRecord(indexed[limitID])
		if bucket == nil {
			continue
		}
		bucketID, hasID := usageText(bucket["limitId"])
		if hasPrimary && (primaryLimitID == limitID || (hasID && primaryLimitID == bucketID)) {
			continue
		}
		buckets = append(buckets, bucket)
	}
	return buckets
}

// ProjectCodexUsage reads `account/rateLimits/read` (projectCodexUsage), its
// result as raw JSON. Native evidence comes from `codex app-server --listen
// stdio://`, followed by `initialize` and `account/rateLimits/read`.
// `rateLimits` is the backward-compatible single-bucket view;
// `rateLimitsByLimitId` is the optional multi-bucket view. email "" is none.
func ProjectCodexUsage(result []byte, email string) (oar.AccountUsageSnapshot, error) {
	root := jsonx.ParseRecord(result)
	historical := jsonx.AsRecord(root["rateLimits"])
	indexed := jsonx.AsRecord(root["rateLimitsByLimitId"])
	buckets := rateLimitBuckets(historical, indexed, objectKeys(jsonx.RawFields(result)["rateLimitsByLimitId"]))
	windows := []oar.AccountUsageWindow{}
	rateLimited := false
	plan := ""
	for _, bucket := range buckets {
		sourceLabel, hasLabel := limitLabel(bucket)
		if plan == "" {
			plan, _ = usageText(bucket["planType"])
		}
		if reached, present := bucket["rateLimitReachedType"]; present && reached != nil {
			rateLimited = true
		}
		for _, kind := range []string{"primary", "secondary"} {
			candidate := jsonx.AsRecord(bucket[kind])
			if candidate == nil {
				continue
			}
			usedPercent, ok := jsonx.Num(candidate, "usedPercent")
			if !ok || usedPercent < 0 || usedPercent > 100 {
				continue
			}
			durationLabel := windowLabel(candidate["windowDurationMins"])
			window := oar.AccountUsageWindow{Label: durationLabel}
			if hasLabel {
				window.Label = sourceLabel + " · " + durationLabel
			}
			// Number((usedPercent / 100).toFixed(6))
			window.UsedRatio, _ = strconv.ParseFloat(strconv.FormatFloat(usedPercent/100, 'f', 6, 64), 64)
			window.ResetsAt, _ = jsonx.EpochInstant(candidate["resetsAt"])
			if limitID, ok := usageText(bucket["limitId"]); ok {
				window.ID = limitID + ":" + kind
			}
			if minutes, ok := jsonx.Num(candidate, "windowDurationMins"); ok && minutes > 0 {
				durationMs := int64(minutes * 60_000)
				window.DurationMs = &durationMs
			}
			windows = append(windows, window)
			rateLimited = rateLimited || usedPercent >= 100
		}
	}
	if len(windows) == 0 {
		return oar.AccountUsageSnapshot{}, errors.New("Codex returned no usable account usage windows")
	}
	return oar.AccountUsageSnapshot{Kind: "available", Plan: plan, Email: email, RateLimited: rateLimited, Windows: windows}, nil
}

// accountEmail reads `account/read` on the same app-server: only a ChatGPT
// (subscription) login carries a meaningful account email; an API-key
// account is dropped per the owner's `type === "chatgpt"` requirement.
func accountEmail(result any) string {
	account := jsonx.AsRecord(jsonx.AsRecord(result)["account"])
	email, ok := account["email"].(string)
	if account["type"] != "chatgpt" || !ok {
		return ""
	}
	return email
}

// isNonSubscriptionAccount: Codex exposes ChatGPT rate-limit windows only
// for a ChatGPT account. API-key and provider-managed runtimes are valid,
// but have no subscription usage for this capability to report.
func isNonSubscriptionAccount(result any) bool {
	root := jsonx.AsRecord(result)
	account := jsonx.AsRecord(root["account"])
	requires, present := root["requiresOpenaiAuth"]
	return account["type"] == "apiKey" || account["type"] == "amazonBedrock" || (present && requires == false)
}

var authenticationRequired = regexp.MustCompile(`(?i)authentication required`)
var endpointMissing = regexp.MustCompile(`(?i)method not found|not supported`)

// readFromAppServer reads the account's usage from its own app-server, within timeout.
func readFromAppServer(ctx context.Context, command string, timeout time.Duration, start startAccountClient) readOutcome {
	client := start(command)
	deadline := time.AfterFunc(timeout, client.kill)
	defer func() {
		deadline.Stop()
		client.kill()
	}()
	if _, err := client.request(ctx, "initialize", initializeParams, nil); err != nil {
		return readFailure(err)
	}
	client.notify("initialized", jsonx.Record{})
	// Read auth mode before the ChatGPT-only rate-limit endpoint. In API-key
	// mode that endpoint rejects with "ChatGPT authentication required" even
	// though Codex itself is correctly authenticated; treating that as
	// expired OAuth would tell the user to perform a login that cannot fix
	// the state.
	var account any
	// Older app-servers may not expose account/read. Preserve the existing
	// rate-limit read in that case instead of making identity mandatory.
	if read, err := client.request(ctx, "account/read", jsonx.Record{}, nil); err == nil {
		account = read.record
	}
	if isNonSubscriptionAccount(account) {
		return readOutcome{kind: "unsupported", reason: "unsupported_auth_mode"}
	}
	result, err := client.request(ctx, "account/rateLimits/read", jsonx.Record{}, nil)
	if err != nil {
		return readFailure(err)
	}
	return readOutcome{kind: "ok", result: result.raw, email: accountEmail(account)}
}

func readFailure(err error) readOutcome {
	message := err.Error()
	if authenticationRequired.MatchString(message) {
		return readOutcome{kind: "reauth_required", reason: "not_authenticated"}
	}
	if endpointMissing.MatchString(message) {
		return readOutcome{kind: "unsupported", reason: "endpoint_unavailable"}
	}
	return readOutcome{kind: "error"}
}

// AccountUsage reads codex's ChatGPT rate-limit windows (codexAccountUsage).
func AccountUsage(ctx context.Context, installation oar.AvailableInstallation, options oar.AccountUsageReadOptions) (oar.AccountUsageSnapshot, error) {
	if installation.Via != "executable" {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "unsupported_installation"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultAccountUsageTimeout
	}
	outcome := readFromAppServer(ctx, installation.Command, timeout, defaultAccountClient)
	switch outcome.kind {
	case "ok":
		return ProjectCodexUsage(outcome.result, outcome.email)
	case "reauth_required", "unsupported":
		return oar.AccountUsageSnapshot{Kind: outcome.kind, Reason: outcome.reason}, nil
	}
	return oar.AccountUsageSnapshot{}, errors.New("Failed to read Codex account usage")
}
