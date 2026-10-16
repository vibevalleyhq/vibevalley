package base

import "crypto/rand"

// codeAlphabet leaves out what reads alike (0 O, 1 I L).
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

func Code(n int) string {
	raw := make([]byte, n)
	rand.Read(raw)
	out := make([]byte, n)
	for i, b := range raw {
		out[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(out)
}
