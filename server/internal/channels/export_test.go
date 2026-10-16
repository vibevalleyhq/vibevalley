package channels

import "time"

// What the gate's tests (lan_test.go, package channels_test: they go through the farm's API) reach inside for.

var LanDeviceName = lanDeviceName

const (
	LanPairingFor = lanPairingFor
	LanWrongTries = lanWrongTries
)

// LanOnLoopback has the gate listen on loopback and call 127.0.0.1 its network address.
func LanOnLoopback(l *Lan) {
	l.host = "127.0.0.1"
	l.address = func() string { return "127.0.0.1" }
}

// LanAt has the gate read the time from now.
func LanAt(l *Lan, now func() time.Time) { l.now = now }
