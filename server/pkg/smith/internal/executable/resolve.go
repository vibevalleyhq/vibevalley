package executable

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Resolve finds an executable through PATH (and PATHEXT on Windows); "" when none.
func Resolve(name string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	if absolute, err := filepath.Abs(path); err == nil {
		return absolute
	}
	return path
}

// ResolveAll is every match on PATH in PATH order, like `which -a`.
func ResolveAll(name string) []string {
	if strings.ContainsRune(name, os.PathSeparator) {
		if resolved := Resolve(name); resolved != "" {
			return []string{resolved}
		}
		return nil
	}
	extensions := []string{""}
	if runtime.GOOS == "windows" {
		extensions = strings.Split(strings.ToLower(os.Getenv("PATHEXT")), ";")
	}
	var found []string
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		for _, extension := range extensions {
			candidate := filepath.Join(dir, name+extension)
			info, err := os.Stat(candidate)
			if err != nil || info.IsDir() {
				continue
			}
			if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
				continue
			}
			found = append(found, candidate)
		}
	}
	return found
}

// VersionReader picks the version out of `--version` stdout.
type VersionReader func(stdout string) string

// ReadVersion runs `<executable> --version` and reads its first line (or
// what read picks). "" when the executable rejects the flag; execution
// failures and timeouts are errors.
func ReadVersion(ctx context.Context, executable string, timeout time.Duration, read VersionReader) (string, error) {
	result := Run(ctx, executable, []string{"--version"}, RunOptions{Timeout: timeout})
	if err := AssertRan(result, "Failed to run "+executable+" --version"); err != nil {
		return "", err
	}
	if !result.OK {
		return "", nil
	}
	if read == nil {
		read = FirstLine
	}
	return strings.TrimSpace(read(result.Stdout)), nil
}
