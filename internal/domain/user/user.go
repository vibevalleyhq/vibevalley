package user

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	authStateFileName     = "auth-state.json"
	defaultPBKDF2Iter     = 120_000
	pbkdf2KeyLen          = 32
	pbkdf2SaltLen         = 16
	passwordMinRunes      = 8
	maxLoginWrongAttempts = 5
	loginLockoutMs        = 60_000
	maxDeviceNameRunes    = 40
	defaultDeviceLabel    = "Device"
)

var (
	// ErrAuthRefused indicates an authentication, password, lockout, or approval refusal.
	ErrAuthRefused = errors.New("user: auth refused")
	// ErrDeviceNotFound indicates the requested device ID does not exist.
	ErrDeviceNotFound = errors.New("user: device not found")
	// ErrApprovalGone indicates an approval request has expired, been denied, or already collected.
	ErrApprovalGone = errors.New("user: approval request gone")
)

// Options configures a user authentication and device token Service.
type Options struct {
	HomeDir          string
	Clock            store.Clock
	PBKDF2Iterations int
}

// Caller describes the origin and authenticated device of an incoming call.
type Caller struct {
	Here     bool
	DeviceID string
	From     string
}

// UserStatus matches packages/protocol/src/user/shapes.ts UserStatus.
type UserStatus struct {
	Name     string      `json:"name"`
	Password bool        `json:"password"`
	Here     bool        `json:"here"`
	Device   *UserDevice `json:"device,omitempty"`
}

// UserLogin matches packages/protocol/src/user/shapes.ts UserLogin.
type UserLogin struct {
	Device string `json:"device"`
	Key    string `json:"key"`
}

// Preview matches packages/protocol/src/common/shapes.ts Preview.
type Preview struct {
	Does []string `json:"does"`
}

type storedAccount struct {
	Name          string `json:"name,omitempty"`
	PasswordHash  string `json:"passwordHash,omitempty"`
	PasswordSetAt int64  `json:"passwordSetAt,omitempty"`
}

type storedAuthState struct {
	Account storedAccount  `json:"account"`
	Devices []storedDevice `json:"devices,omitempty"`
}

// Service manages local owner credentials, PBKDF2 password hashing, device tokens, and CLI login approvals.
type Service struct {
	homeDir    string
	filePath   string
	clock      store.Clock
	pbkdf2Iter int

	loginMu sync.Mutex
	mu      sync.RWMutex

	account     storedAccount
	wrongTries  int
	lockedUntil int64

	devices   map[string]*storedDevice
	approvals map[string]*pendingApproval

	revSubMu sync.Mutex
	revSubs  map[uint64]chan string
	revSeq   uint64
}

// NewService constructs a user Service, reloading $VIBEVALLEY_HOME/auth-state.json when homeDir is set.
func NewService(opts Options) (*Service, error) {
	clk := opts.Clock
	if clk == nil {
		clk = store.RealClock{}
	}
	iter := opts.PBKDF2Iterations
	if iter <= 0 {
		iter = defaultPBKDF2Iter
	}
	homeDir := strings.TrimSpace(opts.HomeDir)
	s := &Service{
		homeDir:    homeDir,
		clock:      clk,
		pbkdf2Iter: iter,
		devices:    make(map[string]*storedDevice),
		approvals:  make(map[string]*pendingApproval),
		revSubs:    make(map[uint64]chan string),
	}
	if homeDir != "" {
		s.filePath = filepath.Join(homeDir, authStateFileName)
		if err := s.loadFromDisk(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// FilePath returns the path to auth-state.json, or "" in memory-only mode.
func (s *Service) FilePath() string { return s.filePath }

// Status returns UserStatus; unauthenticated LAN callers never learn the owner's profile name.
func (s *Service) Status(caller Caller) UserStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var dev *UserDevice
	if caller.DeviceID != "" {
		if d, ok := s.devices[caller.DeviceID]; ok {
			pub := d.public()
			dev = &pub
		}
	}
	seen := caller.Here || dev != nil
	name := ""
	if seen {
		name = s.account.Name
	}
	return UserStatus{
		Name:     name,
		Password: s.account.PasswordHash != "",
		Here:     caller.Here,
		Device:   dev,
	}
}

// Setup configures initial owner profile name and password from loopback when no password is set yet.
func (s *Service) Setup(caller Caller, name, password string) (UserStatus, error) {
	if !caller.Here {
		return UserStatus{}, fmt.Errorf("%w: setup requires local loopback access", ErrAuthRefused)
	}
	if utf8.RuneCountInString(password) < passwordMinRunes {
		return UserStatus{}, fmt.Errorf("%w: password must be at least %d characters", ErrAuthRefused, passwordMinRunes)
	}

	s.mu.Lock()
	if s.account.PasswordHash != "" {
		s.mu.Unlock()
		return UserStatus{}, fmt.Errorf("%w: account is already set up", ErrAuthRefused)
	}
	iter := s.pbkdf2Iter
	s.mu.Unlock()

	hash, err := hashPasswordPBKDF2(password, iter)
	if err != nil {
		return UserStatus{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.account.PasswordHash != "" {
		return UserStatus{}, fmt.Errorf("%w: account is already set up", ErrAuthRefused)
	}
	nextAcc := s.account
	if tidy := TidyName(name); tidy != "" {
		nextAcc.Name = tidy
	}
	nextAcc.PasswordHash = hash
	nextAcc.PasswordSetAt = s.clock.NowMs()
	if err := s.persistLocked(nextAcc, s.devices); err != nil {
		return UserStatus{}, err
	}
	s.account = nextAcc
	s.wrongTries = 0
	s.lockedUntil = 0
	return UserStatus{
		Name:     s.account.Name,
		Password: true,
		Here:     caller.Here,
	}, nil
}

// UpdateProfile updates the owner's display name.
func (s *Service) UpdateProfile(name string) (UserStatus, error) {
	tidy := TidyName(name)

	s.mu.Lock()
	defer s.mu.Unlock()
	nextAcc := s.account
	nextAcc.Name = tidy
	if err := s.persistLocked(nextAcc, s.devices); err != nil {
		return UserStatus{}, err
	}
	s.account = nextAcc
	return UserStatus{
		Name:     s.account.Name,
		Password: s.account.PasswordHash != "",
		Here:     true,
	}, nil
}

// SetPassword sets or replaces the owner password (loopback callers only).
func (s *Service) SetPassword(caller Caller, password string) (UserStatus, error) {
	if !caller.Here {
		return UserStatus{}, fmt.Errorf("%w: password changes require local loopback access", ErrAuthRefused)
	}
	if utf8.RuneCountInString(password) < passwordMinRunes {
		return UserStatus{}, fmt.Errorf("%w: password must be at least %d characters", ErrAuthRefused, passwordMinRunes)
	}

	s.mu.RLock()
	iter := s.pbkdf2Iter
	s.mu.RUnlock()

	hash, err := hashPasswordPBKDF2(password, iter)
	if err != nil {
		return UserStatus{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	nextAcc := s.account
	nextAcc.PasswordHash = hash
	nextAcc.PasswordSetAt = s.clock.NowMs()
	if err := s.persistLocked(nextAcc, s.devices); err != nil {
		return UserStatus{}, err
	}
	s.account = nextAcc
	s.wrongTries = 0
	s.lockedUntil = 0
	return UserStatus{
		Name:     s.account.Name,
		Password: true,
		Here:     true,
	}, nil
}

// ChangePassword verifies oldPassword when a password is already configured and updates to newPassword (loopback only).
func (s *Service) ChangePassword(caller Caller, oldPassword, newPassword string) (UserStatus, error) {
	if !caller.Here {
		return UserStatus{}, fmt.Errorf("%w: password changes require local loopback access", ErrAuthRefused)
	}
	if utf8.RuneCountInString(newPassword) < passwordMinRunes {
		return UserStatus{}, fmt.Errorf("%w: password must be at least %d characters", ErrAuthRefused, passwordMinRunes)
	}

	s.mu.RLock()
	existingHash := s.account.PasswordHash
	iter := s.pbkdf2Iter
	s.mu.RUnlock()

	if existingHash != "" && !verifyPasswordPBKDF2(oldPassword, existingHash) {
		return UserStatus{}, fmt.Errorf("%w: current password is incorrect", ErrAuthRefused)
	}

	newHash, err := hashPasswordPBKDF2(newPassword, iter)
	if err != nil {
		return UserStatus{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	nextAcc := s.account
	nextAcc.PasswordHash = newHash
	nextAcc.PasswordSetAt = s.clock.NowMs()
	if err := s.persistLocked(nextAcc, s.devices); err != nil {
		return UserStatus{}, err
	}
	s.account = nextAcc
	s.wrongTries = 0
	s.lockedUntil = 0
	return UserStatus{
		Name:     s.account.Name,
		Password: true,
		Here:     true,
	}, nil
}

// Login authenticates with password and mints a new "login" device token, enforcing brute-force lockout.
func (s *Service) Login(password, deviceName string) (UserLogin, error) {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()

	s.mu.RLock()
	pwHash := s.account.PasswordHash
	lockedUntil := s.lockedUntil
	s.mu.RUnlock()

	if pwHash == "" {
		return UserLogin{}, fmt.Errorf("%w: password is not configured", ErrAuthRefused)
	}
	now := s.clock.NowMs()
	if now < lockedUntil {
		waitSec := (lockedUntil - now + 999) / 1000
		return UserLogin{}, fmt.Errorf("%w: too many wrong passwords, retry in %ds", ErrAuthRefused, waitSec)
	}

	if !verifyPasswordPBKDF2(password, pwHash) {
		s.mu.Lock()
		s.wrongTries++
		if s.wrongTries >= maxLoginWrongAttempts {
			s.wrongTries = 0
			s.lockedUntil = s.clock.NowMs() + loginLockoutMs
		}
		s.mu.Unlock()
		return UserLogin{}, fmt.Errorf("%w: wrong password", ErrAuthRefused)
	}

	s.mu.Lock()
	s.wrongTries = 0
	s.lockedUntil = 0
	s.mu.Unlock()

	return s.MintDevice(deviceName, DeviceCameLogin)
}

// Logout revokes the device token associated with caller.
func (s *Service) Logout(caller Caller) error {
	if caller.DeviceID == "" {
		return fmt.Errorf("%w: caller is not authenticated as a device", ErrAuthRefused)
	}
	_, err := s.RevokeDevice(caller.DeviceID)
	return err
}

// TidyName collapses runs of whitespace and caps the result to 40 runes.
func TidyName(given string) string {
	joined := strings.Join(strings.Fields(given), " ")
	runes := []rune(joined)
	if len(runes) > maxDeviceNameRunes {
		return string(runes[:maxDeviceNameRunes])
	}
	return joined
}

func hashTokenSHA256(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func constantTimeEqualString(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// pbkdf2HMACSHA256 derives dkLen bytes using RFC 8018 PBKDF2-HMAC-SHA256 with Go stdlib crypto only.
func pbkdf2HMACSHA256(password, salt []byte, iter, keyLen int) []byte {
	const hLen = sha256.Size
	numBlocks := (keyLen + hLen - 1) / hLen
	out := make([]byte, 0, numBlocks*hLen)
	u := make([]byte, hLen)
	t := make([]byte, hLen)
	blockNum := make([]byte, 4)

	mac := hmac.New(sha256.New, password)
	for block := 1; block <= numBlocks; block++ {
		blockNum[0] = byte(block >> 24)
		blockNum[1] = byte(block >> 16)
		blockNum[2] = byte(block >> 8)
		blockNum[3] = byte(block)

		mac.Reset()
		mac.Write(salt)
		mac.Write(blockNum)
		sum := mac.Sum(u[:0])
		copy(t, sum)

		for i := 2; i <= iter; i++ {
			mac.Reset()
			mac.Write(u)
			mac.Sum(u[:0])
			for j := range hLen {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func hashPasswordPBKDF2(password string, iter int) (string, error) {
	salt := make([]byte, pbkdf2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	dk := pbkdf2HMACSHA256([]byte(password), salt, iter, pbkdf2KeyLen)
	return fmt.Sprintf(
		"pbkdf2-sha256:%d:%s:%s",
		iter,
		base64.RawURLEncoding.EncodeToString(salt),
		base64.RawURLEncoding.EncodeToString(dk),
	), nil
}

func verifyPasswordPBKDF2(password, encoded string) bool {
	parts := strings.Split(encoded, ":")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	salt, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(salt) == 0 {
		return false
	}
	expectedDK, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(expectedDK) == 0 {
		return false
	}
	derived := pbkdf2HMACSHA256([]byte(password), salt, iter, len(expectedDK))
	return subtle.ConstantTimeCompare(derived, expectedDK) == 1
}

func randomHexID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hx := hex.EncodeToString(b[:])
	return hx[0:8] + "-" + hx[8:12] + "-" + hx[12:16] + "-" + hx[16:20] + "-" + hx[20:32], nil
}

func (s *Service) loadFromDisk() error {
	raw, err := os.ReadFile(s.filePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", s.filePath, err)
	}
	var st storedAuthState
	if err := json.Unmarshal(raw, &st); err != nil {
		return fmt.Errorf("decode %s: %w", s.filePath, err)
	}
	s.account = st.Account
	for i := range st.Devices {
		d := st.Devices[i]
		s.devices[d.ID] = &d
	}
	return nil
}

func (s *Service) persistLocked(acc storedAccount, devs map[string]*storedDevice) error {
	if s.filePath == "" {
		return nil
	}
	list := make([]storedDevice, 0, len(devs))
	for _, d := range devs {
		list = append(list, *d)
	}
	sortStoredDevices(list)
	data, err := json.MarshalIndent(storedAuthState{
		Account: acc,
		Devices: list,
	}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeAtomic0600(s.filePath, data)
}

func writeAtomic0600(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}
