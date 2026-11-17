package user

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math"
	"sort"
)

const (
	approvalTTLMs          = int64(10 * 60 * 1000)
	maxPendingApprovals    = 5
	collectIntervalSeconds = 2
	slowDownDeltaSeconds   = 5
	collectSlackRatio      = 0.8
	approvalCodeAlphabet   = "BCDFGHJKLMNPQRSTVWXZ"
)

// Approval matches packages/protocol/src/user/shapes.ts Approval.
type Approval struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	From      string `json:"from"`
	AskedAt   int64  `json:"askedAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// ApprovalCreated matches packages/protocol/src/user/shapes.ts ApprovalCreated.
type ApprovalCreated struct {
	Code      string `json:"code"`
	Claim     string `json:"claim"`
	ExpiresAt int64  `json:"expiresAt"`
	Every     int    `json:"every"`
}

// ApprovalCollected matches packages/protocol/src/user/shapes.ts ApprovalCollected.
type ApprovalCollected struct {
	Login *UserLogin `json:"login,omitempty"`
	Every *int       `json:"every,omitempty"`
}

type pendingApproval struct {
	Approval
	claimHash   string
	approved    bool
	every       int
	lastCollect int64
	hasPolled   bool
}

// CreateApproval enqueues an interactive device login approval request (CLI auth login flow).
func (s *Service) CreateApproval(caller Caller, deviceName string) (ApprovalCreated, error) {
	id, err := randomHexID()
	if err != nil {
		return ApprovalCreated{}, err
	}
	code, err := generateApprovalCode()
	if err != nil {
		return ApprovalCreated{}, err
	}
	claimBytes := make([]byte, 32)
	if _, err := rand.Read(claimBytes); err != nil {
		return ApprovalCreated{}, err
	}
	claim := base64.RawURLEncoding.EncodeToString(claimBytes)

	tidy := TidyName(deviceName)
	if tidy == "" {
		tidy = defaultDeviceLabel
	}
	from := ""
	if !caller.Here {
		from = caller.From
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock.NowMs()
	s.pruneApprovalsLocked(now)
	if len(s.approvals) >= maxPendingApprovals {
		return ApprovalCreated{}, fmt.Errorf("%w: too many pending login approvals", ErrAuthRefused)
	}

	expiresAt := now + approvalTTLMs
	s.approvals[id] = &pendingApproval{
		Approval: Approval{
			ID:        id,
			Code:      code,
			Name:      tidy,
			From:      from,
			AskedAt:   now,
			ExpiresAt: expiresAt,
		},
		claimHash: hashTokenSHA256(claim),
		every:     collectIntervalSeconds,
	}
	return ApprovalCreated{
		Code:      code,
		Claim:     claim,
		ExpiresAt: expiresAt,
		Every:     collectIntervalSeconds,
	}, nil
}

// PollApproval checks whether an approval identified by claim has been granted, enforcing RFC 8628 slow_down.
func (s *Service) PollApproval(claim string) (ApprovalCollected, error) {
	if claim == "" {
		return ApprovalCollected{}, ErrApprovalGone
	}
	claimHash := hashTokenSHA256(claim)

	s.mu.Lock()
	now := s.clock.NowMs()
	s.pruneApprovalsLocked(now)

	var found *pendingApproval
	for _, req := range s.approvals {
		if constantTimeEqualString(req.claimHash, claimHash) {
			found = req
		}
	}
	if found == nil {
		s.mu.Unlock()
		return ApprovalCollected{}, fmt.Errorf("%w: login approval not found or expired", ErrApprovalGone)
	}
	if !found.approved {
		minDeltaMs := int64(math.Round(float64(found.every*1000) * collectSlackRatio))
		tooSoon := found.hasPolled && (now-found.lastCollect) < minDeltaMs
		found.hasPolled = true
		found.lastCollect = now
		if tooSoon {
			found.every += slowDownDeltaSeconds
			every := found.every
			s.mu.Unlock()
			return ApprovalCollected{Every: &every}, nil
		}
		s.mu.Unlock()
		return ApprovalCollected{}, nil
	}

	delete(s.approvals, found.ID)
	name := found.Name
	s.mu.Unlock()

	login, err := s.MintDevice(name, DeviceCameLogin)
	if err != nil {
		return ApprovalCollected{}, err
	}
	return ApprovalCollected{Login: &login}, nil
}

// ListApprovals returns all live non-expired pending approval requests ordered by AskedAt.
func (s *Service) ListApprovals() []Approval {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneApprovalsLocked(s.clock.NowMs())
	return s.listApprovalsLocked()
}

// AnswerApproval approves or denies a pending approval request and returns the remaining pending approvals.
func (s *Service) AnswerApproval(id string, allow bool) ([]Approval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneApprovalsLocked(s.clock.NowMs())

	req, ok := s.approvals[id]
	if !ok {
		return nil, fmt.Errorf("%w: login approval not found or expired", ErrApprovalGone)
	}
	if allow {
		req.approved = true
	} else {
		delete(s.approvals, id)
	}
	return s.listApprovalsLocked(), nil
}

func (s *Service) pruneApprovalsLocked(nowMs int64) {
	for id, req := range s.approvals {
		if req.ExpiresAt <= nowMs {
			delete(s.approvals, id)
		}
	}
}

func (s *Service) listApprovalsLocked() []Approval {
	out := make([]Approval, 0, len(s.approvals))
	for _, req := range s.approvals {
		out = append(out, req.Approval)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AskedAt != out[j].AskedAt {
			return out[i].AskedAt < out[j].AskedAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func generateApprovalCode() (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	var out [9]byte
	n := len(approvalCodeAlphabet)
	for i := range 4 {
		out[i] = approvalCodeAlphabet[int(raw[i])%n]
	}
	out[4] = '-'
	for i := range 4 {
		out[5+i] = approvalCodeAlphabet[int(raw[4+i])%n]
	}
	return string(out[:]), nil
}
