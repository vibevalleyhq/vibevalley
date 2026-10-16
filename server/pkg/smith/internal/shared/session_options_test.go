package shared

import (
	"errors"
	"testing"

	"vibevalley/pkg/smith/oar"
)

func TestRefuseSessionOptions(t *testing.T) {
	refused := oar.RefusedSessionOptions{
		oar.OptionMCPServers: "no MCP", oar.OptionDisallowedTools: "no tool denial",
		oar.OptionAdditionalDirectories: "no directories", oar.OptionName: "no names",
	}
	// An empty list is no option given, so no runtime refuses it.
	for _, options := range []oar.SessionOptions{
		{Cwd: "/tmp", MCPServers: []oar.McpServer{}},
		{Cwd: "/tmp", DisallowedTools: []string{}},
		{Cwd: "/tmp", AdditionalDirectories: []string{}},
	} {
		if err := RefuseSessionOptions(refused, options); err != nil {
			t.Errorf("%+v refused: %v", options, err)
		}
	}
	err := RefuseSessionOptions(refused, oar.SessionOptions{Cwd: "/tmp", DisallowedTools: []string{"native_tool"}})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "disallowedTools" || unsupported.Message != `no tool denial: ["native_tool"]` {
		t.Fatalf("err = %#v", err)
	}
	err = RefuseSessionOptions(refused, oar.SessionOptions{Cwd: "/tmp", Name: oar.String("probe")})
	if !errors.As(err, &unsupported) || unsupported.Option != "name" || unsupported.Message != "no names" {
		t.Fatalf("err = %#v", err)
	}
}

func TestCheckSessionName(t *testing.T) {
	for _, name := range []string{"", "   ", "a\x00b"} {
		err := CheckSessionName(oar.SessionOptions{Name: oar.String(name)})
		var unsupported *oar.UnsupportedOptionError
		if !errors.As(err, &unsupported) || unsupported.Option != "name" || unsupported.Message != "name must not be blank or contain NUL characters" {
			t.Errorf("%q: %#v", name, err)
		}
	}
	if err := CheckSessionName(oar.SessionOptions{Name: oar.String("probe")}); err != nil {
		t.Error(err)
	}
	if err := CheckSessionName(oar.SessionOptions{}); err != nil {
		t.Error(err)
	}
}
