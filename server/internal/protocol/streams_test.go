package protocol

import (
	"strings"
	"testing"
)

func TestStreamsHaveOneNameAndPathEach(t *testing.T) {
	names, paths := map[string]bool{}, map[string]bool{}
	if len(Streams) != 3 {
		t.Fatalf("streams: %d", len(Streams))
	}
	for _, s := range Streams {
		if s.Name == "" || names[s.Name] {
			t.Errorf("stream name %q repeated or empty", s.Name)
		}
		if !strings.HasPrefix(s.Path, "/api/v1/") || paths[s.Path] {
			t.Errorf("stream path %q repeated or unversioned", s.Path)
		}
		if len(s.Can) == 0 {
			t.Errorf("stream %s has no caller", s.Name)
		}
		names[s.Name], paths[s.Path] = true, true
	}
}
