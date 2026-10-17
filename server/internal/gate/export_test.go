package gate

import (
	"time"
)

// lan_test.go is package channels_test: these are what it reaches inside for.

var LanDeviceName = lanDeviceName

const (
	LanPairingFor = lanPairingFor
	LanWrongTries = lanWrongTries
)

func LanOnLoopback(l *Service) {
	l.host = "127.0.0.1"
	l.address = func() string { return "127.0.0.1" }
}

func LanAt(l *Service, now func() time.Time) { l.now = now }
