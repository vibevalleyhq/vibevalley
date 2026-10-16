package kimi

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// usageWindowSpec is a quota window's length.
type usageWindowSpec struct {
	duration int64
	// "minute" | "hour" | "day" | "week"
	unit string
}

type usageRow struct {
	name     string
	window   *usageWindowSpec
	used     int64
	limit    int64
	resetsAt string
}

type boosterWallet struct {
	balance      int64
	monthlyLimit *int64
	monthlyUsed  int64
}

func trimmed(value any) string {
	return text(value)
}

// numeric is Math.trunc(Number(value)) for a numeric string, else of a JSON number; false when neither.
func numeric(value any) (int64, bool) {
	if s, ok := value.(string); ok {
		s = strings.TrimSpace(s)
		if s == "" {
			// Number("") is 0.
			return 0, true
		}
		parsed, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) {
			return 0, false
		}
		return int64(math.Trunc(parsed)), true
	}
	parsed, ok := jsonx.AsNumber(value)
	if !ok {
		return 0, false
	}
	return int64(math.Trunc(parsed)), true
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

func usageUnit(value any) string {
	switch value {
	case "TIME_UNIT_MINUTE":
		return "minute"
	case "TIME_UNIT_HOUR":
		return "hour"
	case "TIME_UNIT_DAY":
		return "day"
	case "TIME_UNIT_WEEK":
		return "week"
	}
	return ""
}

func usageWindow(value any) *usageWindowSpec {
	record := jsonx.AsRecord(value)
	duration, ok := numeric(record["duration"])
	unit := usageUnit(record["timeUnit"])
	if !ok || duration <= 0 || unit == "" {
		return nil
	}
	if unit == "minute" && duration >= 60 && duration%60 == 0 {
		return &usageWindowSpec{duration: duration / 60, unit: "hour"}
	}
	return &usageWindowSpec{duration: duration, unit: unit}
}

func usageRowOf(value any, name string, window *usageWindowSpec) *usageRow {
	record := jsonx.AsRecord(value)
	used, usedOK := numeric(record["used"])
	limit, limitOK := numeric(record["limit"])
	if !usedOK && !limitOK {
		return nil
	}
	if name == "" {
		name = trimmed(record["name"])
	}
	return &usageRow{name: name, window: window, used: used, limit: limit, resetsAt: resetInstant(record["resetTime"])}
}

func usageLabel(row usageRow) string {
	if window := row.window; window != nil {
		if window.unit == "week" {
			return "Weekly limit"
		}
		return strconv.FormatInt(window.duration, 10) + window.unit[:1] + " limit"
	}
	if row.name != "" {
		return row.name
	}
	return "Limit"
}

// fixed6 is Number(value.toFixed(6)).
func fixed6(value float64) float64 {
	parsed, _ := strconv.ParseFloat(strconv.FormatFloat(value, 'f', 6, 64), 64)
	return parsed
}

func projectWindow(row usageRow) *oar.AccountUsageWindow {
	if row.limit <= 0 || row.used < 0 {
		return nil
	}
	return &oar.AccountUsageWindow{
		Label:     usageLabel(row),
		UsedRatio: fixed6(math.Max(0, math.Min(1, float64(row.used)/float64(row.limit)))),
		ResetsAt:  row.resetsAt,
	}
}

func moneyCents(value any) *int64 {
	cents, ok := numeric(jsonx.AsRecord(value)["priceInCents"])
	if !ok || cents < 0 {
		return nil
	}
	return &cents
}

func boosterWalletOf(value any) *boosterWallet {
	record := jsonx.AsRecord(value)
	balance := jsonx.AsRecord(record["balance"])
	total, ok := numeric(balance["amount"])
	if balance["type"] != "BOOSTER" || !ok || total <= 0 {
		return nil
	}
	amountLeft, _ := numeric(balance["amountLeft"])
	var limit *int64
	if record["monthlyChargeLimitEnabled"] == true {
		limit = moneyCents(record["monthlyChargeLimit"])
	}
	wallet := &boosterWallet{balance: max(0, amountLeft)}
	if limit != nil && *limit > 0 {
		wallet.monthlyLimit = limit
	}
	if used := moneyCents(record["monthlyUsed"]); used != nil {
		wallet.monthlyUsed = *used
	}
	return wallet
}

// ProjectUsage projects the same managed quota rows that Kimi Code 0.38.0
// renders in `/usage`. email, plan and displayName are "" when unknown.
func ProjectUsage(payload any, email, plan, displayName string) oar.AccountUsageSnapshot {
	root := jsonx.AsRecord(payload)
	var rows []usageRow
	if summary := usageRowOf(root["usage"], "", &usageWindowSpec{duration: 1, unit: "week"}); summary != nil {
		rows = append(rows, *summary)
	}
	if limits, ok := root["limits"].([]any); ok {
		for _, value := range limits {
			limit := jsonx.AsRecord(value)
			if row := usageRowOf(limit["detail"], trimmed(limit["name"]), usageWindow(limit["window"])); row != nil {
				rows = append(rows, *row)
			}
		}
	}
	windows := []oar.AccountUsageWindow{}
	exhausted := false
	for _, row := range rows {
		if window := projectWindow(row); window != nil {
			windows = append(windows, *window)
			if window.UsedRatio == 1 {
				exhausted = true
			}
		}
	}
	extraUsage := boosterWalletOf(root["boosterWallet"])
	if extraUsage != nil && extraUsage.monthlyLimit != nil {
		windows = append(windows, oar.AccountUsageWindow{
			Label:     "Extra Usage monthly limit",
			UsedRatio: fixed6(math.Min(1, float64(extraUsage.monthlyUsed)/float64(*extraUsage.monthlyLimit))),
		})
	}
	// Kimi's Extra Usage balance bypasses exhausted weekly/hourly subscription
	// quotas. A configured monthly spending cap is the only additional blocker.
	headroom := extraUsage != nil && extraUsage.balance > 0 &&
		(extraUsage.monthlyLimit == nil || extraUsage.monthlyUsed < *extraUsage.monthlyLimit)
	return oar.AccountUsageSnapshot{
		Kind:        "available",
		Plan:        plan,
		Email:       email,
		DisplayName: displayName,
		RateLimited: exhausted && !headroom,
		Windows:     windows,
	}
}

// causedError is TS `new Error(message, { cause })`: the cause's text
// travels in the message (errors are strings in Go, GAPS.md).
type causedError struct {
	message string
	cause   error
}

func (e *causedError) Error() string { return e.message + ": " + e.cause.Error() }
func (e *causedError) Unwrap() error { return e.cause }

func fetchUsage(ctx context.Context, auth AuthContext, accessToken string, deadline time.Time) (*http.Response, error) {
	response, err := authorizedGet(ctx, auth.BaseURL+"/usages", accessToken, deadline)
	if err != nil {
		return nil, &causedError{message: "Failed to reach Kimi usage endpoint", cause: err}
	}
	return response, nil
}

// AccountUsage reads kimi's managed quota (kimiAccountUsage).
func AccountUsage(ctx context.Context, installation oar.AvailableInstallation, options oar.AccountUsageReadOptions) (oar.AccountUsageSnapshot, error) {
	if !installation.IsExecutable() {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "unsupported_installation"}, nil
	}
	// Match the probe/session budget: the Node launcher is slow under concurrent load.
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	auth, err := ResolveAuth(ctx, installation.Command, deadline)
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	if auth == nil {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "auth_configuration_unavailable"}, nil
	}
	if auth.Storage != "file" {
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "unsupported_auth_storage"}, nil
	}
	snapshot, err := readUsage(ctx, *auth, deadline)
	if err != nil {
		var reauth *ReauthError
		if errors.As(err, &reauth) {
			return oar.AccountUsageSnapshot{Kind: "reauth_required", Reason: "credentials_missing"}, nil
		}
		return oar.AccountUsageSnapshot{}, &causedError{message: "Failed to read Kimi account usage", cause: err}
	}
	return snapshot, nil
}

func readUsage(ctx context.Context, auth AuthContext, deadline time.Time) (oar.AccountUsageSnapshot, error) {
	accessToken, err := StoredAccessToken(auth)
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	// Promise.all: the usage and the best-effort identity are read together.
	identities := make(chan AccountIdentity, 1)
	go func() { identities <- FetchAccountIdentity(ctx, auth, accessToken, deadline) }()
	response, err := fetchUsage(ctx, auth, accessToken, deadline)
	identity := <-identities
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return oar.AccountUsageSnapshot{Kind: "reauth_required", Reason: "credentials_rejected"}, nil
	case response.StatusCode == http.StatusNotFound:
		return oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "endpoint_unavailable"}, nil
	case response.StatusCode < 200 || response.StatusCode > 299:
		return oar.AccountUsageSnapshot{}, errors.New("Kimi usage endpoint returned HTTP " + strconv.Itoa(response.StatusCode))
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return oar.AccountUsageSnapshot{}, err
	}
	payload, _ := jsonx.Parse(body)
	return ProjectUsage(payload, identity.Email, identity.Plan, identity.DisplayName), nil
}
