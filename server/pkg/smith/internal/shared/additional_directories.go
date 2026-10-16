package shared

import (
	"path/filepath"
	"strings"

	"vibevalley/pkg/smith/oar"
)

// ResolvedAdditionalDirectories is options.AdditionalDirectories as absolute
// native paths resolved against options.Cwd, independent of the host
// process's working directory, deduplicated in order. An empty path or one
// with a NUL is refused.
func ResolvedAdditionalDirectories(options oar.SessionOptions) ([]string, error) {
	for _, directory := range options.AdditionalDirectories {
		if directory == "" || strings.ContainsRune(directory, 0) {
			return nil, &oar.UnsupportedOptionError{Option: "additionalDirectories", Message: "additionalDirectories must contain non-empty paths without NUL characters"}
		}
	}
	seen := map[string]bool{}
	resolved := []string{}
	for _, directory := range options.AdditionalDirectories {
		absolute := resolvePath(options.Cwd, directory)
		if !seen[absolute] {
			seen[absolute] = true
			resolved = append(resolved, absolute)
		}
	}
	return resolved, nil
}

// resolvePath is node's path.resolve(base, target): target when absolute,
// else joined to base, made absolute against the host's cwd and cleaned.
func resolvePath(base, target string) string {
	joined := target
	if !filepath.IsAbs(target) {
		joined = filepath.Join(base, target)
	}
	absolute, err := filepath.Abs(joined)
	if err != nil {
		return filepath.Clean(joined)
	}
	return absolute
}
