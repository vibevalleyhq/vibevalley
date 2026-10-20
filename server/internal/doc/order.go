package doc

import (
	"errors"
	"strings"
)

// Order keys are fractional indexes in base62 (David Greenspan's midpoint between two keys; one digit up or down at either
// end): a key sorts between its neighbours as a plain string, never ends in '0' (so there is always room before it), and
// siblings that got the same key sort by id. lib/rules/doc_blocks.dart makes the same keys on the client.

const keyDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// Long keys come from inserting at one place again and again; past this a key is refused (rebalancing is not done yet).
const maxKeyLen = 256

func validKey(k string) bool {
	if k == "" || len(k) > maxKeyLen || k[len(k)-1] == '0' {
		return false
	}
	for i := 0; i < len(k); i++ {
		if strings.IndexByte(keyDigits, k[i]) < 0 {
			return false
		}
	}
	return true
}

// keyBetween is a key after a and before b; "" for a is the start, "" for b the end.
func keyBetween(a, b string) (string, error) {
	if (a != "" && !validKey(a)) || (b != "" && !validKey(b)) {
		return "", errors.New("不是有效的顺序键")
	}
	if a != "" && b != "" && a >= b {
		return "", errors.New("顺序键 " + a + " 不在 " + b + " 前面")
	}
	switch {
	case b == "":
		return after(a), nil
	case a == "":
		return before(b), nil
	}
	return midpoint(a, b), nil
}

// after steps the first digit up by one, so appending again and again adds a digit only every 61 keys.
func after(a string) string {
	if a == "" {
		return "V"
	}
	return stepUp(a)
}

func stepUp(a string) string {
	if a == "" {
		return "1"
	}
	if i := strings.IndexByte(keyDigits, a[0]); i < len(keyDigits)-1 {
		return string(keyDigits[i+1])
	}
	return a[:1] + stepUp(a[1:])
}

// before steps the first digit down by one; a key never ends in '0', so there is always a digit to step.
func before(b string) string {
	i := strings.IndexByte(keyDigits, b[0])
	switch {
	case i > 1:
		return string(keyDigits[i-1])
	case i == 1:
		return "0z"
	}
	return "0" + before(b[1:])
}

func digitOf(s string, i int) byte {
	if i < len(s) {
		return s[i]
	}
	return '0'
}

func midpoint(a, b string) string {
	if b != "" {
		n := 0
		for n < len(b) && digitOf(a, n) == b[n] {
			n++
		}
		if n > 0 {
			rest := ""
			if n < len(a) {
				rest = a[n:]
			}
			return b[:n] + midpoint(rest, b[n:])
		}
	}
	lo, hi := 0, len(keyDigits)
	if a != "" {
		lo = strings.IndexByte(keyDigits, a[0])
	}
	if b != "" {
		hi = strings.IndexByte(keyDigits, b[0])
	}
	if hi-lo > 1 {
		return string(keyDigits[(lo+hi+1)/2])
	}
	if len(b) > 1 {
		return b[:1]
	}
	rest := ""
	if len(a) > 1 {
		rest = a[1:]
	}
	return string(keyDigits[lo]) + midpoint(rest, "")
}
