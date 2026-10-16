package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

var qualifiedMcpTool = regexp.MustCompile(`^mcp__\w+__.+$`)
var wordName = regexp.MustCompile(`^\w+$`)

// jsonText is JSON.stringify of a plain value (no HTML escaping).
func jsonText(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(out.String(), "\n")
}

// validateCodexToolDenials refuses what codex cannot deny (tool-denials.ts):
// app-server has no builtin deny channel. MCP names must identify a server
// and its native tool; the server is resolved against effective config.
func validateCodexToolDenials(options oar.SessionOptions) error {
	unsupported := []string{}
	for _, name := range options.DisallowedTools {
		if !qualifiedMcpTool.MatchString(name) {
			unsupported = append(unsupported, name)
		}
	}
	if len(unsupported) > 0 {
		return &oar.UnsupportedOptionError{Option: "disallowedTools", Message: "codex only filters MCP tools qualified as mcp__server__tool; built-in or unqualified names have no native deny channel: " + jsonText(unsupported)}
	}
	return nil
}

// codexToolDenialsConfig keeps existing native denies and emits only
// per-server disabled_tools overrides. No credentials or other user
// configuration from config/read are copied.
func codexToolDenialsConfig(options oar.SessionOptions, effective jsonx.Record) (jsonx.Record, error) {
	if err := validateCodexToolDenials(options); err != nil {
		return nil, err
	}
	configured := jsonx.AsRecord(effective["mcp_servers"])
	servers := []string{}
	seen := map[string]bool{}
	add := func(name string) {
		if !seen[name] {
			seen[name] = true
			servers = append(servers, name)
		}
	}
	for _, name := range sortedKeys(configured) {
		add(name)
	}
	for _, server := range options.MCPServers {
		add(server.Name)
	}
	groupOrder := []string{}
	groups := map[string][]string{}
	unsupported := []string{}
	for _, name := range options.DisallowedTools {
		// Non-word server names are normalized by native tool qualification;
		// don't guess at them or choose one of two possible server prefixes.
		var matching []string
		for _, server := range servers {
			if wordName.MatchString(server) && strings.HasPrefix(name, "mcp__"+server+"__") {
				matching = append(matching, server)
			}
		}
		if len(matching) != 1 {
			unsupported = append(unsupported, name)
			continue
		}
		server := matching[0]
		tool := name[len("mcp__"+server+"__"):]
		if tool == "" {
			unsupported = append(unsupported, name)
			continue
		}
		if _, ok := groups[server]; !ok {
			groupOrder = append(groupOrder, server)
		}
		groups[server] = append(groups[server], tool)
	}
	if len(unsupported) > 0 {
		return nil, &oar.UnsupportedOptionError{Option: "disallowedTools", Message: "codex cannot identify one configured MCP server with an unmodified native namespace for: " + jsonText(unsupported)}
	}
	denials := jsonx.Record{}
	for _, server := range groupOrder {
		names := groups[server]
		prior, present := jsonx.AsRecord(configured[server])["disabled_tools"]
		previous := []string{}
		if present && prior != nil {
			list, isList := prior.([]any)
			valid := isList
			for _, entry := range list {
				name, isString := entry.(string)
				valid = valid && isString
				if isString {
					previous = append(previous, name)
				}
			}
			if !valid {
				return nil, &oar.UnsupportedOptionError{Option: "disallowedTools", Message: "codex cannot preserve the existing disabled_tools for server " + jsonText(server) + " while disabling " + jsonText(names)}
			}
		}
		disabled := []any{}
		kept := map[string]bool{}
		for _, name := range append(previous, names...) {
			if !kept[name] {
				kept[name] = true
				disabled = append(disabled, name)
			}
		}
		denials[server] = jsonx.Record{"disabled_tools": disabled}
	}
	return denials, nil
}

// sortedKeys is a record's keys, sorted: the order JS's Object.keys would
// give is lost in decoding, and it only decides which of two matching
// servers is reported first.
func sortedKeys(record jsonx.Record) []string {
	keys := make([]string, 0, len(record))
	for name := range record {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}

// withCodexToolDenials adds denials without dropping session MCP launch configuration.
func withCodexToolDenials(params, denials jsonx.Record) jsonx.Record {
	config := jsonx.AsRecord(params["config"])
	servers := jsonx.Record{}
	for name, value := range jsonx.AsRecord(config["mcp_servers"]) {
		servers[name] = value
	}
	for server, denied := range denials {
		merged := jsonx.Record{}
		for key, value := range jsonx.AsRecord(servers[server]) {
			merged[key] = value
		}
		for key, value := range jsonx.AsRecord(denied) {
			merged[key] = value
		}
		servers[server] = merged
	}
	nextConfig := jsonx.Record{}
	for key, value := range config {
		nextConfig[key] = value
	}
	nextConfig["mcp_servers"] = servers
	next := jsonx.Record{}
	for key, value := range params {
		next[key] = value
	}
	next["config"] = nextConfig
	return next
}

// prepareCodexToolDenials resolves session filters before thread creation;
// it releases the process on refusal.
func prepareCodexToolDenials(ctx context.Context, client appServerClient, options oar.SessionOptions, params jsonx.Record) (jsonx.Record, error) {
	if len(options.DisallowedTools) == 0 {
		return params, nil
	}
	effective, err := client.request(ctx, "config/read", jsonx.Record{"cwd": options.Cwd, "includeLayers": false}, nil)
	var denials jsonx.Record
	if err == nil {
		denials, err = codexToolDenialsConfig(options, jsonx.AsRecord(effective.record["config"]))
	}
	if err != nil {
		client.kill()
		<-client.exited()
		return nil, err
	}
	return withCodexToolDenials(params, denials), nil
}
