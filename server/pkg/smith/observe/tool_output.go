package observe

import "vibevalley/pkg/smith/oar"

// ToolResultText is the text of a tool result for a host that shows only
// text (observe/tool-output.ts): its text parts joined by newlines, or false
// when it has none (an image, a block OAR does not recognize).
func ToolResultText(content []oar.ToolOutputPart) (string, bool) {
	return oar.ToolResultText(content)
}
