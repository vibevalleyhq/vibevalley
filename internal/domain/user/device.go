package user

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

const (
	// DeviceKeyCookie is the HttpOnly cookie name accepted alongside Authorization: Bearer at the LAN gate.
	DeviceKeyCookie = "vibevalley_device_key"

	deviceKeyPrefix     = "vvk_"
	deviceKeyByteLen    = 32
	idleRevokeMs        = int64(90 * 24 * 3600 * 1000)
	lastSeenPersistStep = int64(60 * 1000)
)

// DeviceCame records how a device obtained its access token.
type DeviceCame string

const (
	DeviceCamePaired DeviceCame = "paired"
	DeviceCameLogin  DeviceCame = "login"
)

// UserDevice matches packages/protocol/src/user/shapes.ts UserDevice (never includes key hashes).
type UserDevice struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Came     DeviceCame `json:"came"`
	AddedAt  int64      `json:"addedAt"`
	LastSeen *int64     `json:"lastSeen,omitempty"`
}

type storedDevice struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Came        DeviceCame `json:"came"`
	KeyHash     string     `json:"keyHash"`
	AddedAt     int64      `json:"addedAt"`
	LastSeen    *int64     `json:"lastSeen,omitempty"`
	writtenSeen int64
}

func (d *storedDevice) public() UserDevice {
	var seen *int64
	if d.LastSeen != nil {
		v := *d.LastSeen
		seen = &v
	}
	return UserDevice{
		ID:       d.ID,
		Name:     d.Name,
		Came:     d.Came,
		AddedAt:  d.AddedAt,
		LastSeen: seen,
	}
}

// MintDevice creates a new device entry, stores only its SHA-256 hash, and returns the raw key once.
func (s *Service) MintDevice(deviceName string, came DeviceCame) (UserLogin, error) {
	if came != DeviceCameLogin && came != DeviceCamePaired {
		came = DeviceCamePaired
	}
	rawBytes := make([]byte, deviceKeyByteLen)
	if _, err := rand.Read(rawBytes); err != nil {
		return UserLogin{}, fmt.Errorf("generate device key: %w", err)
	}
	rawKey := deviceKeyPrefix + base64.RawURLEncoding.EncodeToString(rawBytes)
	id, err := randomHexID()
	if err != nil {
		return UserLogin{}, fmt.Errorf("generate device id: %w", err)
	}
	tidy := TidyName(deviceName)
	if tidy == "" {
		tidy = defaultDeviceLabel
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock.NowMs()
	dev := &storedDevice{
		ID:      id,
		Name:    tidy,
		Came:    came,
		KeyHash: hashTokenSHA256(rawKey),
		AddedAt: now,
	}
	nextDevs := make(map[string]*storedDevice, len(s.devices)+1)
	for k, v := range s.devices {
		nextDevs[k] = v
	}
	nextDevs[id] = dev
	if err := s.persistLocked(s.account, nextDevs); err != nil {
		return UserLogin{}, err
	}
	s.devices[id] = dev
	return UserLogin{Device: id, Key: rawKey}, nil
}

// VerifyToken checks rawKey in constant time, enforces 90-day idle expiry, and updates LastSeen.
func (s *Service) VerifyToken(rawKey string) (UserDevice, bool) {
	if rawKey == "" {
		return UserDevice{}, false
	}
	candidateHash := hashTokenSHA256(rawKey)

	s.mu.Lock()
	defer s.mu.Unlock()

	var found *storedDevice
	for _, d := range s.devices {
		if constantTimeEqualString(d.KeyHash, candidateHash) {
			found = d
			// Do not break early to minimize timing leakage across stored devices.
		}
	}
	if found == nil {
		return UserDevice{}, false
	}

	now := s.clock.NowMs()
	if s.isIdleLocked(found, now) {
		delete(s.devices, found.ID)
		_ = s.persistLocked(s.account, s.devices)
		s.notifyRevoked(found.ID)
		return UserDevice{}, false
	}

	found.LastSeen = &now
	if now-found.writtenSeen >= lastSeenPersistStep {
		found.writtenSeen = now
		_ = s.persistLocked(s.account, s.devices)
	}
	return found.public(), true
}

// ListDevices returns all active non-revoked devices ordered by AddedAt ascending.
func (s *Service) ListDevices() []UserDevice {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listDevicesLocked()
}

// RevokeDevice removes the device with id and notifies revocation subscribers.
func (s *Service) RevokeDevice(id string) ([]UserDevice, error) {
	s.mu.Lock()
	if _, ok := s.devices[id]; !ok {
		s.mu.Unlock()
		return nil, fmt.Errorf("%w: %s", ErrDeviceNotFound, id)
	}
	nextDevs := make(map[string]*storedDevice, len(s.devices))
	for k, v := range s.devices {
		if k != id {
			nextDevs[k] = v
		}
	}
	if err := s.persistLocked(s.account, nextDevs); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	delete(s.devices, id)
	list := s.listDevicesLocked()
	s.mu.Unlock()

	s.notifyRevoked(id)
	return list, nil
}

// PreviewRevokeDevice returns a dry-run Preview describing what RevokeDevice would do.
func (s *Service) PreviewRevokeDevice(id string) (Preview, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.devices[id]
	if !ok {
		return Preview{}, fmt.Errorf("%w: %s", ErrDeviceNotFound, id)
	}
	return Preview{
		Does: []string{fmt.Sprintf("Revoke access key for device %q (%s)", d.Name, d.ID)},
	}, nil
}

// SweepIdle revokes all devices unused for >= 90 days and returns their IDs.
func (s *Service) SweepIdle() []string {
	s.mu.Lock()
	now := s.clock.NowMs()
	var expired []string
	for id, d := range s.devices {
		if s.isIdleLocked(d, now) {
			expired = append(expired, id)
			delete(s.devices, id)
		}
	}
	if len(expired) > 0 {
		_ = s.persistLocked(s.account, s.devices)
	}
	s.mu.Unlock()

	for _, id := range expired {
		s.notifyRevoked(id)
	}
	return expired
}

// SubscribeRevoked returns a channel receiving revoked device IDs and an unsubscribe cleanup function.
func (s *Service) SubscribeRevoked() (<-chan string, func()) {
	ch := make(chan string, 16)
	s.revSubMu.Lock()
	s.revSeq++
	id := s.revSeq
	s.revSubs[id] = ch
	s.revSubMu.Unlock()

	unsub := func() {
		s.revSubMu.Lock()
		if existing, ok := s.revSubs[id]; ok {
			delete(s.revSubs, id)
			close(existing)
		}
		s.revSubMu.Unlock()
	}
	return ch, unsub
}

// ExtractTokenFromRequest extracts the bearer token or vibevalley_device_key cookie from an HTTP request.
func ExtractTokenFromRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	for _, rawCookie := range r.Cookies() {
		if rawCookie.Name == DeviceKeyCookie {
			if decoded, err := url.QueryUnescape(rawCookie.Value); err == nil {
				return decoded
			}
			return rawCookie.Value
		}
	}
	return ""
}

func (s *Service) isIdleLocked(d *storedDevice, nowMs int64) bool {
	ref := d.AddedAt
	if d.LastSeen != nil {
		ref = *d.LastSeen
	}
	return nowMs-ref >= idleRevokeMs
}

func (s *Service) listDevicesLocked() []UserDevice {
	out := make([]UserDevice, 0, len(s.devices))
	for _, d := range s.devices {
		out = append(out, d.public())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AddedAt != out[j].AddedAt {
			return out[i].AddedAt < out[j].AddedAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func sortStoredDevices(list []storedDevice) {
	sort.Slice(list, func(i, j int) bool {
		if list[i].AddedAt != list[j].AddedAt {
			return list[i].AddedAt < list[j].AddedAt
		}
		return list[i].ID < list[j].ID
	})
}

func (s *Service) notifyRevoked(id string) {
	s.revSubMu.Lock()
	defer s.revSubMu.Unlock()
	for _, ch := range s.revSubs {
		select {
		case ch <- id:
		default:
		}
	}
}
