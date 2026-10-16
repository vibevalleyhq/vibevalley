package pi

import (
	"regexp"
	"strconv"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// ProviderError is the provider failure pi reported for a run.
type ProviderError struct {
	Message string
	// pi-ai's isContextOverflow on the message that carried it.
	Overflow bool
}

var statusPrefixed = regexp.MustCompile(`^(\d{3}) ([\s\S]*)$`)

// Failure classifies the run pi failed with err (failure.ts piFailure): an
// oversized context, then the body's code or type, then the status.
func Failure(err ProviderError) oar.TurnOutcome {
	var status *int
	body := err.Message
	if match := statusPrefixed.FindStringSubmatch(err.Message); match != nil {
		value, _ := strconv.Atoi(match[1])
		status = &value
		body = match[2]
	}
	outcome := oar.Failed(oar.FailureUnknown, err.Message)
	outcome.Status = status
	switch {
	case err.Overflow:
		outcome.Failure = oar.FailureInputTooLarge
	default:
		if named, ok := shared.FailureFromErrorBody(body); ok {
			outcome.Failure = named
		} else if status != nil {
			outcome.Failure = shared.FailureFromStatus(*status)
		}
	}
	return outcome
}

// pi-ai 1.1.0 utils/overflow.js, the patterns isContextOverflow tests an
// errored assistant message against (TS calls it without a context window,
// so only these apply).
var overflowPatterns = compileAll(
	`(?i)prompt (?:is )?too long`,
	`(?i)prompt exceeds max length`,
	`(?i)request_too_large`,
	`(?i)input is too long for requested model`,
	`(?i)exceeds the context window`,
	`(?i)exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))`,
	`(?i)input token count.*exceeds the maximum`,
	`(?i)maximum prompt length is \d+`,
	`(?i)reduce the length of the messages`,
	`(?i)maximum context length is \d+ tokens`,
	`(?i)exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?`,
	`(?i)input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)`,
	`(?i)exceeds the limit of \d+`,
	`(?i)exceeds the available context size`,
	`(?i)greater than the context length`,
	`(?i)context window exceeds limit`,
	`(?i)exceeded model token limit`,
	`(?i)too large for model with \d+ maximum context length`,
	`(?i)prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?`,
	`(?i)model_context_window_exceeded`,
	`(?i)prompt too long; exceeded (?:max )?context length`,
	`(?i)range of input length should be`,
	`(?i)context[_ ]length[_ ]exceeded`,
	`(?i)too many tokens`,
	`(?i)token limit exceeded`,
)

var nonOverflowPatterns = compileAll(
	`(?i)^(Throttling error|Service unavailable):`,
	`(?i)rate limit`,
	`(?i)too many requests`,
)

var cerebrasBodyless = regexp.MustCompile(`(?i)^4(?:00|13)\s*(?:status code)?\s*\(no body\)`)

func compileAll(patterns ...string) []*regexp.Regexp {
	compiled := make([]*regexp.Regexp, 0, len(patterns))
	for _, pattern := range patterns {
		compiled = append(compiled, regexp.MustCompile(pattern))
	}
	return compiled
}

func anyMatch(patterns []*regexp.Regexp, text string) bool {
	for _, pattern := range patterns {
		if pattern.MatchString(text) {
			return true
		}
	}
	return false
}

// IsContextOverflow is pi-ai's isContextOverflow(message) without a context
// window: an errored assistant message whose error text names an overflow.
func IsContextOverflow(message map[string]any) bool {
	if message["stopReason"] != "error" {
		return false
	}
	text, _ := message["errorMessage"].(string)
	if text == "" || anyMatch(nonOverflowPatterns, text) {
		return false
	}
	if anyMatch(overflowPatterns, text) {
		return true
	}
	return message["provider"] == "cerebras" && cerebrasBodyless.MatchString(text)
}
