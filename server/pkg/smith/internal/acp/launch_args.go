package acp

import "vibevalley/pkg/smith/oar"

// LaunchArgs is the agent's argv for a session: the profile's args, with the
// host's own (SessionOptions.LaunchArgs) where the profile places them,
// after by default (launch-args.ts).
func LaunchArgs(profile Profile, options oar.SessionOptions) []string {
	var args []string
	if profile.Args != nil {
		args = profile.Args(options)
	}
	if len(options.LaunchArgs) == 0 {
		return append([]string{}, args...)
	}
	if profile.WithLaunchArgs != nil {
		return profile.WithLaunchArgs(append([]string{}, args...), options.LaunchArgs)
	}
	return append(append([]string{}, args...), options.LaunchArgs...)
}
