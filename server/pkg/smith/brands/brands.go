// Package brands holds offline runtime branding (packages/oar/src/brands.ts;
// see packages/oar/assets/brands/NOTICE.md). brands_gen.go is generated.
package brands

//go:generate pnpm tsx generate.ts

import "vibevalley/pkg/smith/oar"

// Of is a runtime's brand; the id as its name with no icon when unknown.
func Of(id string) oar.RuntimeBrand {
	if brand, ok := Runtime[id]; ok {
		return brand
	}
	return oar.RuntimeBrand{Name: id}
}
