package shared

import (
	"regexp"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Failure classes from what a runtime reveals, most structured first
// (docs/spec/runtime-matrix.md#failure-evidence): the runtime's own category
// (each adapter maps its own), then the provider's error body (type, code),
// then the HTTP status. Only causes some runtime was observed to report are
// mapped; prose matching is each adapter's documented last resort.

// Classified is a failed outcome's classification: the class, and the HTTP
// status where the runtime said it.
type Classified struct {
	Failure oar.FailureClass
	Status  *int
}

// FailureFromStatus is what an HTTP status means at the providers (the
// Anthropic, OpenAI and Gemini error references) when nothing richer says.
// A 401 says the credential failed, not whether it was missing or refused;
// a 400 is any rejected request.
func FailureFromStatus(status int) oar.FailureClass {
	switch status {
	case 400:
		return oar.FailureInvalidRequest
	case 401:
		return oar.FailureAuth
	case 402:
		return oar.FailureBilling
	case 404:
		return oar.FailureModelUnavailable
	case 429:
		return oar.FailureRateLimited
	case 503, 529:
		return oar.FailureOverloaded
	}
	if status >= 500 && status < 600 {
		return oar.FailureProvider
	}
	return oar.FailureUnknown
}

// errorCodes are provider error codes and types some runtime was observed
// to carry: OpenAI's codes (and its ChatGPT backend's usage_limit_reached,
// usage_not_included), Anthropic's types. An OpenAI 429 is a quota or a
// billing failure when its code says so, throttling only when it does not.
var errorCodes = map[string]oar.FailureClass{
	"invalid_api_key":                   oar.FailureAuth,
	"model_not_found":                   oar.FailureModelUnavailable,
	"rate_limit_exceeded":               oar.FailureRateLimited,
	"insufficient_quota":                oar.FailureQuota,
	"organization_usage_limit_exceeded": oar.FailureQuota,
	"usage_limit_reached":               oar.FailureQuota,
	"usage_not_included":                oar.FailureQuota,
	"credit_balance_exhausted":          oar.FailureBilling,
	"context_length_exceeded":           oar.FailureInputTooLarge,
	"server_is_overloaded":              oar.FailureOverloaded,
	"authentication_error":              oar.FailureAuth,
	"not_found_error":                   oar.FailureModelUnavailable,
	"rate_limit_error":                  oar.FailureRateLimited,
	"billing_error":                     oar.FailureBilling,
	"overloaded_error":                  oar.FailureOverloaded,
	"api_error":                         oar.FailureProvider,
	"server_error":                      oar.FailureProvider,
	"invalid_request_error":             oar.FailureInvalidRequest,
}

// FailureFromErrorCode is the class a provider error code or type names;
// false for one no runtime was seen to carry.
func FailureFromErrorCode(code string) (oar.FailureClass, bool) {
	failure, ok := errorCodes[code]
	return failure, ok
}

var (
	creditBalanceText = regexp.MustCompile(`(?i)credit balance is too low`)
	usageLimitsText   = regexp.MustCompile(`(?i)reached your specified API usage limits`)
)

// AnthropicLimitText reads Anthropic's 400s that have no type of their own
// (both are invalid_request_error): an organization's spend limit and an
// exhausted credit balance. Matched on the API's own wording, the last
// resort for the adapters that carry Anthropic's message (claude, pi).
func AnthropicLimitText(message string) (oar.FailureClass, bool) {
	if creditBalanceText.MatchString(message) {
		return oar.FailureBilling, true
	}
	if usageLimitsText.MatchString(message) {
		return oar.FailureQuota, true
	}
	return "", false
}

// FailureFromErrorBody reads a provider's JSON error body, as Anthropic
// ({type: "error", error: {type, message}}) and OpenAI ({error: {code,
// type, message}}) send it: the class its code names, else its type's
// (Anthropic's 400 wording first). False when text is no such body or names
// nothing known.
func FailureFromErrorBody(text string) (oar.FailureClass, bool) {
	value, _ := jsonx.Parse([]byte(text))
	failure := jsonx.AsRecord(jsonx.AsRecord(value)["error"])
	if failure == nil {
		return "", false
	}
	if code, ok := failure["code"].(string); ok {
		if class, ok := FailureFromErrorCode(code); ok {
			return class, true
		}
	}
	message, _ := failure["message"].(string)
	if failure["type"] == "invalid_request_error" {
		if class, ok := AnthropicLimitText(message); ok {
			return class, true
		}
		return oar.FailureInvalidRequest, true
	}
	if kind, ok := failure["type"].(string); ok {
		return FailureFromErrorCode(kind)
	}
	return "", false
}

var (
	authProse           = regexp.MustCompile(`(?i)\b401\b|authenticat(?:e|ed|ion)|\boauth\b|unauthorized|invalid (?:user )?(?:x-)?api[- ]?key|x-api-key|log(?:ged)? ?in`)
	rateLimitProse      = regexp.MustCompile(`(?i)\b429\b|rate.?limit`)
	quotaProse          = regexp.MustCompile(`(?i)quota|usage limit`)
	billingProse        = regexp.MustCompile(`(?i)billing`)
	invalidRequestProse = regexp.MustCompile(`(?i)\b400\b|invalid_request|issue with the selected model|model .* (?:does not|doesn't|may not) exist|unknown model|invalid model`)
	overloadedProse     = regexp.MustCompile(`(?i)\b529\b|\b503\b|overloaded`)
	providerProse       = regexp.MustCompile(`(?i)\b\d{3}\b|error`)
)

// ClassifyFailure is the best-effort classification of vendor error prose:
// the documented last resort of the adapters whose runtime reports no
// structure for a failure (opencode's prompt errors). The patterns are
// pinned by the vendor snapshot tests: when a runtime changes its wording,
// the snapshot moves and this table gets a conscious update.
func ClassifyFailure(reason string) oar.FailureClass {
	if authProse.MatchString(reason) {
		return oar.FailureAuth
	}
	if limit, ok := AnthropicLimitText(reason); ok {
		return limit
	}
	switch {
	case rateLimitProse.MatchString(reason):
		return oar.FailureRateLimited
	case quotaProse.MatchString(reason):
		return oar.FailureQuota
	case billingProse.MatchString(reason):
		return oar.FailureBilling
	case invalidRequestProse.MatchString(reason):
		return oar.FailureInvalidRequest
	case overloadedProse.MatchString(reason):
		return oar.FailureOverloaded
	case providerProse.MatchString(reason):
		return oar.FailureProvider
	}
	return oar.FailureUnknown
}
