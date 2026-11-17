package artifact

import (
	"fmt"
	"strings"
)

const (
	orderKeyDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	maxOrderKeyLen = 256
)

// ValidOrderKey checks whether k is a valid non-empty base62 fractional order key not ending in '0'.
func ValidOrderKey(k string) bool {
	if k == "" || len(k) > maxOrderKeyLen || k[len(k)-1] == '0' {
		return false
	}
	for i := range len(k) {
		if strings.IndexByte(orderKeyDigits, k[i]) < 0 {
			return false
		}
	}
	return true
}

// KeyBetween returns a fractional order key strictly ordered between a and b.
// Pass "" for a to insert before the first sibling, or "" for b to append after the last sibling.
func KeyBetween(a, b string) (string, error) {
	if (a != "" && !ValidOrderKey(a)) || (b != "" && !ValidOrderKey(b)) {
		return "", fmt.Errorf("%w: invalid key (%q, %q)", ErrInvalidOrderKey, a, b)
	}
	if a != "" && b != "" && a >= b {
		return "", fmt.Errorf("%w: %q >= %q", ErrInvalidOrderKey, a, b)
	}
	if b == "" {
		return keyAfter(a), nil
	}
	if a == "" {
		return keyBefore(b), nil
	}
	key := keyMidpoint(a, b)
	if !ValidOrderKey(key) {
		return "", fmt.Errorf("%w: midpoint key exceeded max length", ErrInvalidOrderKey)
	}
	return key, nil
}

func keyAfter(a string) string {
	if a == "" {
		return "V"
	}
	return keyStepUp(a)
}

func keyStepUp(a string) string {
	if a == "" {
		return "1"
	}
	head := a[0]
	idx := strings.IndexByte(orderKeyDigits, head)
	if idx < len(orderKeyDigits)-1 {
		return string(orderKeyDigits[idx+1])
	}
	return string(head) + keyStepUp(a[1:])
}

func keyBefore(b string) string {
	idx := 0
	if b != "" {
		idx = strings.IndexByte(orderKeyDigits, b[0])
	}
	if idx > 1 {
		return string(orderKeyDigits[idx-1])
	}
	if idx == 1 {
		return "0z"
	}
	return "0" + keyBefore(b[1:])
}

func keyMidpoint(a, b string) string {
	if b != "" {
		n := 0
		for n < len(b) {
			da := byte('0')
			if n < len(a) {
				da = a[n]
			}
			if da != b[n] {
				break
			}
			n++
		}
		if n > 0 {
			tailA := ""
			if n < len(a) {
				tailA = a[n:]
			}
			return b[:n] + keyMidpoint(tailA, b[n:])
		}
	}

	lo := 0
	if a != "" {
		lo = strings.IndexByte(orderKeyDigits, a[0])
	}
	hi := len(orderKeyDigits)
	if b != "" {
		hi = strings.IndexByte(orderKeyDigits, b[0])
	}
	if hi-lo > 1 {
		return string(orderKeyDigits[(lo+hi+1)/2])
	}
	if len(b) > 1 {
		return b[:1]
	}
	tailA := ""
	if len(a) > 1 {
		tailA = a[1:]
	}
	return string(orderKeyDigits[lo]) + keyMidpoint(tailA, "")
}
