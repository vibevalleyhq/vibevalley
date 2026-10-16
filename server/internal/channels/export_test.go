package channels

import "time"

// lan_test.go is package channels_test: these are what it reaches inside for.

var LanDeviceName = lanDeviceName

const (
	LanPairingFor = lanPairingFor
	LanWrongTries = lanWrongTries
)

func LanOnLoopback(l *Lan) {
	l.host = "127.0.0.1"
	l.address = func() string { return "127.0.0.1" }
}

func LanAt(l *Lan, now func() time.Time) { l.now = now }
