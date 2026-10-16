package claude

import (
	"errors"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// claudeServiceTierArgs are the flags for a requested tier. Flags apply to
// this process only; user settings files are never edited (service-tier.ts).
func claudeServiceTierArgs(requested string) ([]string, error) {
	if requested == "" {
		return nil, nil
	}
	if requested != "fast" && requested != "default" {
		return nil, errors.New("claude cannot apply serviceTier " + requested + "; its tiers are default and fast (on supported models)")
	}
	return []string{"--settings", jsonText(map[string]bool{"fastMode": requested == "fast"})}, nil
}

// claudeServiceTierEvents is claude's native fast-mode status, including a
// temporary downgrade during cooldown.
func claudeServiceTierEvents(message jsonx.Record) []oar.EventBody {
	switch message["fast_mode_state"] {
	case "on":
		return []oar.EventBody{oar.ServiceTier{ServiceTier: "fast"}}
	case "off", "cooldown":
		return []oar.EventBody{oar.ServiceTier{ServiceTier: "default"}}
	}
	return nil
}

// claudeServiceTierRefusal reads initialization, which reports applied
// state; get_settings.effective.fastMode is only configuration intent. ""
// when the requested tier applies.
func claudeServiceTierRefusal(requested string, answer jsonx.Record) string {
	response := jsonx.AsRecord(answer["response"])
	applied := jsonx.AsRecord(response["response"])
	status := applied["fast_mode_state"]
	want := "off"
	if requested == "fast" {
		want = "on"
	}
	if response["subtype"] == "success" && status == want {
		return ""
	}
	actual, ok := status.(string)
	if !ok {
		actual = "unreported"
	}
	var reason any
	if response["subtype"] == "success" {
		reason = applied["fast_mode_disabled_reason"]
	} else {
		reason = response["error"]
	}
	refusal := "claude reports fast_mode_state " + actual + " although serviceTier " + requested + " was requested"
	if text, ok := reason.(string); ok {
		refusal += " (" + text + ")"
	}
	return refusal
}
