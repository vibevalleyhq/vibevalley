package ai

import "strings"

// ContentText is the words in some content: text blocks joined by separator ("\n" in TS's default), the rest
// left out.
func ContentText(content []Content, separator string) string {
	var parts []string
	for _, c := range content {
		if c.Type == TypeText {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, separator)
}

// Words is ContentText of a UserContent: the string, or its text blocks joined.
func (c UserContent) Words(separator string) string {
	if !c.IsBlocks() {
		return c.Text
	}
	return ContentText(c.Blocks, separator)
}
