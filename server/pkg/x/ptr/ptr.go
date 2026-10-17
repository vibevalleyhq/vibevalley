// Package ptr is for the optional fields of the shapes, which are pointers.
package ptr

// To is a pointer to a copy of v.
func To[T any](v T) *T { return &v }

// Or is what p points at, or fallback when p is nil.
func Or[T any](p *T, fallback T) T {
	if p == nil {
		return fallback
	}
	return *p
}

// Value is what p points at, or the zero value when p is nil.
func Value[T any](p *T) T {
	var zero T
	return Or(p, zero)
}
