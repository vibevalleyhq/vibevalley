package shared

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
)

func TestAdditionalDirectoriesResolveAgainstCwd(t *testing.T) {
	cwd, _ := filepath.Abs("project")
	extra := filepath.Join(filepath.Dir(cwd), "extra directory")
	directories := []string{"../extra directory", extra, "."}
	got, err := ResolvedAdditionalDirectories(oar.SessionOptions{Cwd: cwd, AdditionalDirectories: directories})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{extra, cwd}) {
		t.Fatalf("got %v", got)
	}
	if !reflect.DeepEqual(directories, []string{"../extra directory", extra, "."}) {
		t.Fatalf("the host's list changed: %v", directories)
	}
	_, err = ResolvedAdditionalDirectories(oar.SessionOptions{Cwd: cwd, AdditionalDirectories: []string{""}})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "additionalDirectories" || !strings.Contains(err.Error(), "non-empty paths") {
		t.Fatalf("err = %v", err)
	}
	if _, err := ResolvedAdditionalDirectories(oar.SessionOptions{Cwd: cwd, AdditionalDirectories: []string{"a\x00b"}}); err == nil {
		t.Fatal("a NUL path is refused")
	}
	if got, _ := ResolvedAdditionalDirectories(oar.SessionOptions{Cwd: cwd}); got == nil || len(got) != 0 {
		t.Fatalf("none given: %v", got)
	}
}
