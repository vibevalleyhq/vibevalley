package lan

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"
)

const (
	pairingTTLMs        = int64(2 * 60 * 1000)
	maxPairingWrongTry  = 5
	pairingCodeDigits   = 6
	defaultPairingLabel = "Device"
)

type pairingPhase int

const (
	phaseAwaitingCode pairingPhase = iota + 1
	phaseAwaitingApproval
)

type pairingSession struct {
	phase     pairingPhase
	code      string
	expiresAt int64
	wrong     int
	asking    string
	answerCh  chan bool
}

// StartPairing generates a fresh 6-digit pairing code with a 2-minute TTL and QR pairing URI.
func (s *Service) StartPairing() (LanStatus, error) {
	code, err := generate6DigitCode()
	if err != nil {
		return LanStatus{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.open {
		return LanStatus{}, fmt.Errorf("%w: LAN access is closed", ErrLanForbidden)
	}
	addr := s.advertisedURL(s.boundPort)
	if addr == "" {
		return LanStatus{}, fmt.Errorf("%w: no local network address available", ErrLanForbidden)
	}

	s.dropPairingLocked(false)
	s.pairing = &pairingSession{
		phase:     phaseAwaitingCode,
		code:      code,
		expiresAt: s.clock.NowMs() + pairingTTLMs,
	}
	return s.statusLocked(), nil
}

// StopPairing cancels any active pairing code or pending approval prompt.
func (s *Service) StopPairing() LanStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropPairingLocked(false)
	return s.statusLocked()
}

// PreviewStop returns a dry-run Preview describing what StopPairing would cancel.
func (s *Service) PreviewStop() Preview {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneExpiredPairingLocked()
	if s.pairing == nil {
		return Preview{Does: []string{"No active pairing code"}}
	}
	does := []string{fmt.Sprintf("Cancel pairing code %s", s.pairing.code)}
	if s.pairing.phase == phaseAwaitingApproval && s.pairing.asking != "" {
		does = append(does, fmt.Sprintf("Reject pending device %q", s.pairing.asking))
	}
	return Preview{Does: does}
}

// AnswerPairing approves or rejects a device currently waiting in PairWithCode.
func (s *Service) AnswerPairing(allow bool) (LanStatus, error) {
	s.mu.Lock()
	s.pruneExpiredPairingLocked()
	p := s.pairing
	if p == nil || p.phase != phaseAwaitingApproval {
		s.mu.Unlock()
		return LanStatus{}, fmt.Errorf("%w: no device waiting for pairing approval", ErrLanForbidden)
	}
	answerCh := p.answerCh
	s.pairing = nil
	st := s.statusLocked()
	s.mu.Unlock()

	if answerCh != nil {
		select {
		case answerCh <- allow:
		default:
		}
	}
	return st, nil
}

// PairWithCode submits a 6-digit pairing code and device name, waiting for owner AnswerPairing approval
// (or until the 2-minute TTL expires / ctx cancels) and mints a paired token via DeviceMinter.
func (s *Service) PairWithCode(ctx context.Context, code, deviceName string) (LanPaired, error) {
	if err := ctx.Err(); err != nil {
		return LanPaired{}, err
	}
	cleanName := tidyDeviceName(deviceName)
	if cleanName == "" {
		cleanName = defaultPairingLabel
	}
	cleanCode := strings.TrimSpace(code)

	s.mu.Lock()
	if !s.open {
		s.mu.Unlock()
		return LanPaired{}, fmt.Errorf("%w: LAN access is closed", ErrLanForbidden)
	}
	s.pruneExpiredPairingLocked()
	p := s.pairing
	if p == nil {
		s.mu.Unlock()
		return LanPaired{}, fmt.Errorf("%w: pairing code expired or not active", ErrLanForbidden)
	}
	if !constantTimeEqual(cleanCode, p.code) {
		if p.phase == phaseAwaitingCode {
			p.wrong++
			if p.wrong >= maxPairingWrongTry {
				s.dropPairingLocked(false)
			}
		}
		s.mu.Unlock()
		return LanPaired{}, fmt.Errorf("%w: incorrect pairing code", ErrLanForbidden)
	}
	if p.phase == phaseAwaitingApproval {
		s.mu.Unlock()
		return LanPaired{}, fmt.Errorf("%w: another device is awaiting approval", ErrLanForbidden)
	}

	answerCh := make(chan bool, 1)
	expiresAt := s.clock.NowMs() + pairingTTLMs
	p.phase = phaseAwaitingApproval
	p.asking = cleanName
	p.expiresAt = expiresAt
	p.answerCh = answerCh
	minter := s.minter
	hostLabel := s.label
	s.mu.Unlock()

	remainingMs := expiresAt - s.clock.NowMs()
	if remainingMs < 0 {
		remainingMs = 0
	}
	timedOut := make(chan struct{})
	timer := s.clock.AfterFunc(time.Duration(remainingMs)*time.Millisecond, func() {
		close(timedOut)
	})
	defer timer.Stop()

	var allow bool
	select {
	case allow = <-answerCh:
	case <-timedOut:
		s.mu.Lock()
		if s.pairing == p {
			s.pairing = nil
		}
		s.mu.Unlock()
		return LanPaired{}, fmt.Errorf("%w: pairing approval timed out", ErrLanForbidden)
	case <-ctx.Done():
		s.mu.Lock()
		if s.pairing == p {
			s.pairing = nil
		}
		s.mu.Unlock()
		return LanPaired{}, ctx.Err()
	}

	if !allow {
		return LanPaired{}, fmt.Errorf("%w: pairing request denied", ErrLanForbidden)
	}
	if minter == nil {
		return LanPaired{}, fmt.Errorf("%w: device minter not configured", ErrLanUnavailable)
	}
	minted, err := minter(ctx, cleanName)
	if err != nil {
		return LanPaired{}, err
	}
	return LanPaired{
		Device:   minted.Device,
		Key:      minted.Key,
		HostName: hostLabel,
	}, nil
}

func (s *Service) pruneExpiredPairingLocked() {
	if s.pairing == nil {
		return
	}
	if s.clock.NowMs() >= s.pairing.expiresAt {
		s.dropPairingLocked(false)
	}
}

func (s *Service) dropPairingLocked(allow bool) {
	if s.pairing == nil {
		return
	}
	if s.pairing.phase == phaseAwaitingApproval && s.pairing.answerCh != nil {
		select {
		case s.pairing.answerCh <- allow:
		default:
		}
	}
	s.pairing = nil
}

func pairURI(baseURL, code string) string {
	return strings.TrimRight(baseURL, "/") + "/pair?c=" + url.QueryEscape(code)
}

func generate6DigitCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func tidyDeviceName(given string) string {
	joined := strings.Join(strings.Fields(given), " ")
	runes := []rune(joined)
	if len(runes) > 40 {
		return string(runes[:40])
	}
	return joined
}
