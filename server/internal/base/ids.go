package base

import (
	"crypto/rand"

	"github.com/google/uuid"
)

// NewID is the id of a row the server makes: a uuidv7, which carries the time it was made, so rows sort in the order they
// were written. google/uuid keeps the sequence in one process monotonic, so a message made in the same millisecond as the
// one before it still sorts after it. A clock that goes backwards across a restart can put a new id before an old one;
// with one farm on one machine that is accepted (finish-the-renames).
func NewID() string {
	id, err := uuid.NewV7()
	if err != nil {
		panic("uuidv7: " + err.Error())
	}
	return id.String()
}

// codeAlphabet leaves out what reads alike (0 O, 1 I L).
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// Code is a short human code, for pairing a device: not an id, and never a key.
func Code(n int) string {
	raw := make([]byte, n)
	rand.Read(raw)
	out := make([]byte, n)
	for i, b := range raw {
		out[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(out)
}
