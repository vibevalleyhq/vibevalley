package durable

// Pin modernc.org/sqlite in go.mod so parallel workers build offline against one lock.
import _ "modernc.org/sqlite"
