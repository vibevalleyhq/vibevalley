// Package opencode is the Go port of packages/oar/src/runtimes/opencode:
// `opencode acp`, opencode's own ACP layer over its HTTP server, on the
// shared ACP session (internal/acp). Both native release lines (OpenCode 1
// and 2) share one command name; the session picks the profile by line.
package opencode

import (
	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
)

// ChildAttribution reads the child session v2 forwards on the root envelope
// (attribution.ts): native metadata `opencode/child-session {id, parentID}`
// on the update, or on the envelope, owns the identity. nil when the
// lineage is incomplete; it is never fabricated.
func ChildAttribution(notification jsonx.Record) *acp.Attribution {
	update := jsonx.AsRecord(notification["update"])
	child := jsonx.AsRecord(jsonx.Get(update, "_meta", "opencode/child-session"))
	if child == nil {
		child = jsonx.AsRecord(jsonx.Get(notification, "_meta", "opencode/child-session"))
	}
	id, idOK := child["id"].(string)
	parent, parentOK := child["parentID"].(string)
	if update == nil || !idOK || id == "" || !parentOK || parent == "" || id == parent {
		return nil
	}
	return &acp.Attribution{SessionID: id, Parent: parent}
}
