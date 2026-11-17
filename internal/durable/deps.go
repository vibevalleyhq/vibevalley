package durable

// Pin goja in go.mod so CodeMode deterministic execution builds without mutating the lock during Swarm.
import _ "github.com/dop251/goja"
