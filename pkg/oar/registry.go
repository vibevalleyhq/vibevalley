package oar

import (
	"slices"
	"sync"
)

// Registry maps runtime IDs to Driver implementations.
type Registry struct {
	mu      sync.RWMutex
	order   []string
	drivers map[string]Driver
}

// NewRegistry builds a Registry initialized with the supplied drivers.
func NewRegistry(drivers ...Driver) *Registry {
	r := &Registry{
		drivers: make(map[string]Driver, len(drivers)),
	}
	for _, d := range drivers {
		r.Register(d)
	}
	return r
}

// DefaultRegistry returns a Registry containing all built-in OAR runtime drivers.
func DefaultRegistry() *Registry {
	return NewRegistry(
		NewClaudeDriver(),
		NewCodexDriver(),
		NewACPDriver(OpenCodeProfile()),
		NewACPDriver(GrokProfile()),
		NewACPDriver(KimiProfile()),
		NewACPDriver(CodeBuddyProfile()),
		NewQwenDriver(),
		NewQoderDriver(),
	)
}

// Register adds or replaces a driver keyed by its ID.
func (r *Registry) Register(d Driver) {
	if d == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	id := d.ID()
	if _, exists := r.drivers[id]; !exists {
		r.order = append(r.order, id)
	}
	r.drivers[id] = d
}

// Get returns the registered driver for id, if any.
func (r *Registry) Get(id string) (Driver, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.drivers[id]
	return d, ok
}

// List returns all registered drivers in deterministic registration order.
func (r *Registry) List() []Driver {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Driver, 0, len(r.order))
	for _, id := range r.order {
		if d, ok := r.drivers[id]; ok {
			out = append(out, d)
		}
	}
	return out
}

// IDs returns the registered runtime IDs in registration order.
func (r *Registry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return slices.Clone(r.order)
}
