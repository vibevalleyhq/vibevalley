package protocol

import (
	_ "embed"
	"encoding/json"
)

//go:embed template_catalog.json
var templateCatalogJSON []byte

var templateCatalog struct {
	Kinds []TemplateKind `json:"kinds"`
}

func init() {
	if err := json.Unmarshal(templateCatalogJSON, &templateCatalog); err != nil {
		panic("protocol: template_catalog.json: " + err.Error())
	}
}

// The issue templates on the sowing form, in its order, as written: Done still holds {test}, {lint} and {build}. A copy each call.
func TemplateCatalog() []TemplateKind {
	out := make([]TemplateKind, len(templateCatalog.Kinds))
	for i, k := range templateCatalog.Kinds {
		out[i] = k
		out[i].Templates = append([]IssueTemplate(nil), k.Templates...)
	}
	return out
}
