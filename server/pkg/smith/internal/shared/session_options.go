package shared

import (
	"strings"

	"vibevalley/pkg/smith/oar"
)

// refusableOrder is the order TS checks refusals in (shared/session-options.ts).
var refusableOrder = []oar.RefusableSessionOption{
	oar.OptionSystemPrompt, oar.OptionAppendSystemPrompt, oar.OptionEnv, oar.OptionMCPServers,
	oar.OptionDisallowedTools, oar.OptionLaunchArgs, oar.OptionServiceTier,
	oar.OptionAdditionalDirectories, oar.OptionOutputSchema, oar.OptionName,
}

// SessionOptionGiven reports whether options gives key: any set value
// (including an empty schema), a non-empty map for env, a non-empty list
// for list options.
func SessionOptionGiven(options oar.SessionOptions, key oar.RefusableSessionOption) bool {
	return options.Given(key)
}

// RefuseSessionOptions rejects an open that gives an option the runtime
// declares refused: an UnsupportedOptionError naming it, with the declared
// reason (for disallowedTools, followed by ": " and the JSON list).
func RefuseSessionOptions(refused oar.RefusedSessionOptions, options oar.SessionOptions) error {
	for _, key := range refusableOrder {
		reason, ok := refused[key]
		if !ok || !SessionOptionGiven(options, key) {
			continue
		}
		if key == oar.OptionDisallowedTools {
			reason = reason + ": " + jsonText(options.DisallowedTools)
		}
		return &oar.UnsupportedOptionError{Option: string(key), Message: reason}
	}
	return nil
}

// CheckSessionName refuses a blank SessionOptions.Name, or one with a NUL
// character, before anything starts, as invalid additionalDirectories are:
// claude and pi would open unnamed without a word, codex would refuse a
// blank one only after the thread opened, and no command line can carry a NUL.
func CheckSessionName(options oar.SessionOptions) error {
	if options.Name != nil && (jsTrim(*options.Name) == "" || strings.ContainsRune(*options.Name, 0)) {
		return &oar.UnsupportedOptionError{Option: "name", Message: "name must not be blank or contain NUL characters"}
	}
	return nil
}
