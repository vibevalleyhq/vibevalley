package grok

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

func centValue(value any) (float64, bool) {
	return jsonx.AsNumber(jsonx.AsRecord(value)["val"])
}

func parseInstant(text string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05", "2006-01-02"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func resetInstant(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	parsed, ok := parseInstant(s)
	if !ok {
		return ""
	}
	return shared.UtcInstantFromDate(parsed)
}

func periodLabel(value any) string {
	s, ok := value.(string)
	if !ok {
		return "Included usage"
	}
	normalized := strings.ToLower(strings.TrimPrefix(s, "USAGE_PERIOD_TYPE_"))
	if normalized == "" {
		return " included usage"
	}
	return strings.ToUpper(normalized[:1]) + normalized[1:] + " included usage"
}

// fixed6 is Number(value.toFixed(6)).
func fixed6(value float64) float64 {
	parsed, _ := strconv.ParseFloat(strconv.FormatFloat(value, 'f', 6, 64), 64)
	return parsed
}

// AccountEmail extracts identity only from grok's authenticated
// `_x.ai/auth/info` result; "" when there is none.
func AccountEmail(result any) string {
	return text(jsonx.AsRecord(result)["email"])
}

// ProjectUsage projects `_x.ai/billing`; email "" is unknown.
func ProjectUsage(result any, email string) (oar.AccountUsageSnapshot, error) {
	root := jsonx.AsRecord(result)
	config := jsonx.AsRecord(root["config"])
	if config == nil {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "quota_unavailable"}, nil
	}
	// Match Grok's credit_balance_from_config: an existing billing config
	// without percentage or legacy metrics defaults to zero usage. The native
	// /usage UI uses this for accounts that have not consumed credits yet.
	missingMetrics := config["creditUsagePercent"] == nil && config["used"] == nil && config["monthlyLimit"] == nil
	used, usedOK := centValue(config["used"])
	limit, limitOK := centValue(config["monthlyLimit"])
	usedPercent, ok := jsonx.AsNumber(config["creditUsagePercent"])
	if !ok && usedOK && limitOK && limit > 0 {
		usedPercent, ok = used/limit*100, true
	}
	if !ok && missingMetrics {
		usedPercent, ok = 0, true
	}
	if !ok || usedPercent < 0 {
		return oar.AccountUsageSnapshot{}, errors.New("Grok returned no usable account usage percentage")
	}
	period := jsonx.AsRecord(config["currentPeriod"])
	end := period["end"]
	if end == nil {
		end = config["billingPeriodEnd"]
	}
	resetsAt := resetInstant(end)
	prepaid, _ := centValue(config["prepaidBalance"])
	prepaidBalance := math.Abs(prepaid)
	onDemandCap, _ := centValue(config["onDemandCap"])
	legacyOnDemandUsed := 0.0
	if usedOK && limitOK {
		legacyOnDemandUsed = math.Max(0, used-limit)
	}
	onDemandUsed, onDemandOK := centValue(config["onDemandUsed"])
	if !onDemandOK {
		onDemandUsed = legacyOnDemandUsed
	}
	var onDemandRatio *float64
	if onDemandCap > 0 {
		ratio := math.Max(0, math.Min(1, onDemandUsed/onDemandCap))
		onDemandRatio = &ratio
	}
	windows := []oar.AccountUsageWindow{{
		Label:     periodLabel(period["type"]),
		UsedRatio: fixed6(math.Min(1, usedPercent/100)),
		ResetsAt:  resetsAt,
	}}
	if onDemandRatio != nil {
		windows = append(windows, oar.AccountUsageWindow{Label: "Pay-as-you-go", UsedRatio: fixed6(*onDemandRatio), ResetsAt: resetsAt})
	}
	// The current ACP extension serializes its Rust top-level field as
	// `subscription_tier`; accept the earlier camel-case spelling as a
	// compatibility fallback. Nested billing config fields remain camel-case.
	rawPlan := root["subscription_tier"]
	if rawPlan == nil {
		rawPlan = root["subscriptionTier"]
	}
	// Grok's own credit-bar projection treats a positive prepaid balance or an
	// unexhausted on-demand cap as usable headroom after included usage reaches
	// 100%; do not report the account as rate-limited while either remains.
	rateLimited := usedPercent >= 100 && prepaidBalance == 0 && (onDemandRatio == nil || *onDemandRatio >= 1)
	return oar.AccountUsageSnapshot{Kind: "available", Plan: text(rawPlan), Email: email, RateLimited: rateLimited, Windows: windows}, nil
}

const usageName = "Grok account usage"

type accountPayload struct {
	billing jsonx.Record
	email   string
}

func readBilling(ctx context.Context, command string, timeout time.Duration) (accountPayload, error) {
	// One budget for the whole read, shared by every request.
	deadline := time.Now().Add(timeout)
	remaining := func() (time.Duration, error) { return shared.Remaining(deadline, usageName) }
	process, err := startReader(ctx, command, "", hostCwd(), remaining)
	if err != nil {
		return accountPayload{}, err
	}
	defer func() {
		process.Kill()
		<-process.Exited()
	}()
	budget, err := remaining()
	if err != nil {
		return accountPayload{}, err
	}
	answer, err := process.Request(ctx, "_x.ai/billing", map[string]any{}, budget)
	if err != nil {
		return accountPayload{}, err
	}
	billing := jsonx.ParseRecord(answer)
	email := ""
	// Older Grok builds and transient identity failures must not hide the
	// billing result that was already read successfully.
	if budget, err := remaining(); err == nil {
		if info, err := process.Request(ctx, "_x.ai/auth/info", map[string]any{}, budget); err == nil {
			parsed, _ := jsonx.Parse(info)
			email = AccountEmail(parsed)
		}
	}
	return accountPayload{billing: billing, email: email}, nil
}

// AccountUsage reads `_x.ai/billing` (grokAccountUsage).
func AccountUsage(ctx context.Context, installation oar.AvailableInstallation, options oar.AccountUsageReadOptions) (oar.AccountUsageSnapshot, error) {
	if !installation.IsExecutable() {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "unsupported_installation"}, nil
	}
	// One grok start and up to four requests, which a slow launcher stretches.
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	payload, err := readBilling(ctx, installation.Command, timeout)
	if err == nil {
		var snapshot oar.AccountUsageSnapshot
		if snapshot, err = ProjectUsage(payload.billing, payload.email); err == nil {
			return snapshot, nil
		}
	}
	var failure *acp.RequestError
	if errors.As(err, &failure) {
		if failure.Code == -32601 {
			return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "endpoint_unavailable"}, nil
		}
		if failure.Code == -32000 || authWords.MatchString(failure.Message) {
			return oar.AccountUsageSnapshot{Kind: "reauth_required", Reason: "not_authenticated"}, nil
		}
	}
	return oar.AccountUsageSnapshot{}, &causedError{message: "Failed to read Grok account usage", cause: err}
}
