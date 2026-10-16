package ai

import "strings"

func ContentText(content []Content, separator string) string {
	var parts []string
	for _, c := range content {
		if c.Type == TypeText {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, separator)
}

func (c UserContent) Words(separator string) string {
	if !c.IsBlocks() {
		return c.Text
	}
	return ContentText(c.Blocks, separator)
}
