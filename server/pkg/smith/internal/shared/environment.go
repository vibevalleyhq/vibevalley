package shared

import (
	"os"
	"runtime"
	"strings"
)

// Environment is a fresh child environment ("NAME=value" entries) from the
// host's: a value overrides, nil removes, and the host is untouched
// (shared/environment.ts).
func Environment(overlay map[string]*string) []string {
	return EnvironmentFrom(overlay, os.Environ(), runtime.GOOS)
}

// EnvironmentFrom is Environment over an inherited environment on goos
// ("windows" folds names). inherited is never modified.
func EnvironmentFrom(overlay map[string]*string, inherited []string, goos string) []string {
	type entry struct{ name, value string }
	entries := make([]entry, 0, len(inherited)+len(overlay))
	for _, line := range inherited {
		name, value, _ := strings.Cut(line, "=")
		entries = append(entries, entry{name, value})
	}
	remove := func(match func(string) bool) {
		kept := entries[:0]
		for _, current := range entries {
			if !match(current.name) {
				kept = append(kept, current)
			}
		}
		entries = kept
	}
	for key, value := range overlay {
		if goos == "windows" {
			// Windows environment names are case-insensitive. Remove every
			// spelling before setting, so no alias survives beside it.
			remove(func(name string) bool { return strings.EqualFold(name, key) })
		} else {
			remove(func(name string) bool { return name == key })
		}
		if value != nil {
			entries = append(entries, entry{key, *value})
		}
	}
	environment := make([]string, 0, len(entries))
	for _, current := range entries {
		environment = append(environment, current.name+"="+current.value)
	}
	return environment
}
