package main

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
)

// Every endpoint has its own command, and the command finds it again.
func TestEveryEndpointHasACommand(t *testing.T) {
	seen := map[string]string{}
	for _, e := range protocol.Endpoints {
		group, op, _ := strings.Cut(e.Op, ".")
		command := group + " " + kebab(op)
		if other, ok := seen[command]; ok {
			t.Errorf("%s and %s are both `%s`", other, e.Op, command)
		}
		seen[command] = e.Op
		if got, ok := endpoint(group, kebab(op)); !ok || got.Op != e.Op {
			t.Errorf("`%s` finds %q", command, got.Op)
		}
	}
	if kebab("archiveFile") != "archive-file" || kebab("list") != "list" {
		t.Fatal(kebab("archiveFile"))
	}
}

func TestArgs(t *testing.T) {
	a, err := parseArgs([]string{"issue", "start", "t1", "--server", "http://x", "--json={}", "--watch"})
	if err != nil || strings.Join(a.words, " ") != "issue start t1" || a.flags["server"] != "http://x" || a.flags["json"] != "{}" || a.flags["watch"] != "true" {
		t.Fatalf("%+v %v", a, err)
	}
	if _, err := parseArgs([]string{"--server"}); err == nil {
		t.Fatal("a flag with no value")
	}
}
