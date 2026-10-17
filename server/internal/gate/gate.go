package gate

import (
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/ptr"
)

// The farm itself listens on loopback alone; the gate is a second listener on every interface, shut until the owner opens it. Through it go
// VibeValleyApi and the state and side-event streams, never /mcp, and only with a paired device's key: sessions run commands on this machine without asking. Opening
// it, pairing and forgetting devices are this machine's alone. The database keeps only each key's SHA-256. The gate speaks plain HTTP: a key can be
// overheard on the network it is open on.

const (
	// A device's asking gets as long again for the owner to answer.
	lanPairingFor = 2 * time.Minute
	lanWrongTries = 5
	lanSeenEvery  = time.Minute
)

type lanDevice struct {
	protocol.LanDevice
	keyHash string
	written int64
}

type lanPairing struct {
	code    string
	expires time.Time
	asking  string
	answer  chan bool
	wrong   int
}

type lanDeviceKey struct{}

type Service struct {
	q *generated.Queries
	// handler.New hands it over before the farm starts, since the API answers for every service, the gate's own pages included.
	API     http.Handler
	host    string
	port    int
	address func() string
	now     func() time.Time
	ctx     context.Context

	mu       sync.Mutex
	open     bool
	server   *http.Server
	listener net.Listener
	problem  string
	pairing  *lanPairing
	devices  map[string]*lanDevice // by id
	// Forgetting a device ends them.
	conns map[string]map[int]context.CancelFunc
	next  int
}

func newService(cfg base.Config, db *sql.DB) (*Service, error) {
	l := &Service{q: generated.New(db), port: cfg.Lan.Port, address: lanAddress, now: time.Now, devices: map[string]*lanDevice{}, conns: map[string]map[int]context.CancelFunc{}}
	ctx := context.Background()
	rows, err := l.q.LanDevices(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		d := &lanDevice{LanDevice: protocol.LanDevice{ID: row.ID, Name: row.Name, PairedAt: row.PairedAt}, keyHash: row.KeyHash}
		if row.LastSeen.Valid {
			d.LastSeen, d.written = &row.LastSeen.Int64, row.LastSeen.Int64
		}
		l.devices[d.ID] = d
	}
	open, err := l.q.GateOpen(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	l.open = open
	return l, nil
}

func (l *Service) OnStart(ctx context.Context) error {
	l.ctx = ctx
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open {
		l.listen()
	}
	return nil
}

func (l *Service) OnStop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.shut()
}

// Called with mu held. A port taken is said in the status; the farm runs on.
func (l *Service) listen() {
	if l.server != nil {
		return
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(l.host, strconv.Itoa(l.port)))
	if err != nil {
		l.problem = "院门开不起来：" + err.Error()
		log.Printf("vibevalley: the yard gate cannot listen on port %d: %v", l.port, err)
		return
	}
	l.problem = ""
	l.listener = listener
	ctx := l.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	l.server = &http.Server{
		Handler:           l.gate(l.API),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go l.server.Serve(listener)
	log.Printf("vibevalley: the yard gate is open on %s", listener.Addr())
}

// Called with mu held.
func (l *Service) shut() {
	l.dropPairing()
	if l.server != nil {
		l.server.Close()
		log.Printf("vibevalley: the yard gate is shut")
	}
	l.server, l.listener = nil, nil
}

func (l *Service) SetOpen(open bool) (protocol.LanStatus, error) {
	if err := l.q.SetGateOpen(context.Background(), open); err != nil {
		return protocol.LanStatus{}, err
	}
	l.mu.Lock()
	l.open = open
	if open {
		l.listen()
	} else {
		l.problem = ""
		l.shut()
	}
	l.mu.Unlock()
	return l.Status(), nil
}

func (l *Service) Status() protocol.LanStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := protocol.LanStatus{Open: l.open, Farm: lanFarmName(), Devices: []protocol.LanDevice{}}
	if l.problem != "" {
		s.Problem = &l.problem
	}
	gate := l.url()
	if l.open && l.listener != nil {
		if gate == "" {
			s.Problem = ptr.To("找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试")
		} else {
			s.URL = &gate
		}
	}
	if p := l.livePairing(); p != nil && gate != "" {
		s.Pairing = &protocol.LanPairing{Code: p.code, Link: lanPairLink(gate, p.code), ExpiresAt: p.expires.UnixMilli()}
		if p.asking != "" {
			s.Pairing.Asking = ptr.To(p.asking)
		}
	}
	for _, d := range l.devices {
		s.Devices = append(s.Devices, d.LanDevice)
	}
	slices.SortFunc(s.Devices, func(a, b protocol.LanDevice) int { return cmp.Compare(a.PairedAt, b.PairedAt) })
	return s
}

// Called with mu held.
func (l *Service) url() string {
	if l.listener == nil {
		return ""
	}
	host := l.address()
	if host == "" {
		return ""
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(l.listener.Addr().(*net.TCPAddr).Port))
}

func lanPairLink(gate, code string) string {
	return "vibevalley://pair?u=" + url.QueryEscape(gate) + "&c=" + url.QueryEscape(code)
}

// Called with mu held.
func (l *Service) livePairing() *lanPairing {
	if l.pairing != nil && !l.now().Before(l.pairing.expires) {
		l.dropPairing()
	}
	return l.pairing
}

// Called with mu held.
func (l *Service) dropPairing() {
	if l.pairing != nil && l.pairing.asking != "" {
		l.pairing.answer <- false
	}
	l.pairing = nil
}

func (l *Service) StartPairing() (protocol.LanStatus, error) {
	l.mu.Lock()
	if !l.open || l.listener == nil {
		l.mu.Unlock()
		return protocol.LanStatus{}, protocol.LanRefused{Reason: "院门还没开：先打开它"}
	}
	if l.url() == "" {
		l.mu.Unlock()
		return protocol.LanStatus{}, protocol.LanRefused{Reason: "找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试"}
	}
	l.dropPairing()
	l.pairing = &lanPairing{code: base.Code(10), expires: l.now().Add(lanPairingFor), answer: make(chan bool, 1)}
	l.mu.Unlock()
	return l.Status(), nil
}

func (l *Service) StopPairing() protocol.LanStatus {
	l.mu.Lock()
	l.dropPairing()
	l.mu.Unlock()
	return l.Status()
}

// The code is used up either way.
func (l *Service) Answer(allow bool) (protocol.LanStatus, error) {
	l.mu.Lock()
	p := l.livePairing()
	if p == nil || p.asking == "" {
		l.mu.Unlock()
		return protocol.LanStatus{}, protocol.LanRefused{Reason: "没有设备在等你点头"}
	}
	p.answer <- allow
	l.pairing = nil
	l.mu.Unlock()
	return l.Status(), nil
}

func (l *Service) Pair(ctx context.Context, code, name string) (protocol.LanPaired, error) {
	name = lanDeviceName(name)
	l.mu.Lock()
	p := l.livePairing()
	switch {
	case !l.open:
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "院门关着：回那台电脑上打开院门"}
	case p == nil:
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "配对码过期了：回那台电脑上换一个码"}
	case subtle.ConstantTimeCompare([]byte(strings.ToUpper(strings.TrimSpace(code))), []byte(p.code)) != 1:
		p.wrong++
		if p.wrong >= lanWrongTries {
			l.dropPairing()
		}
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "配对码不对"}
	case p.asking != "":
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "另一台设备正在等主人点头：等一会儿再试"}
	}
	p.asking = name
	p.expires = l.now().Add(lanPairingFor)
	answer := p.answer
	l.mu.Unlock()
	log.Printf("vibevalley: the yard gate: %q asks to pair", name)

	wait := time.NewTimer(lanPairingFor)
	defer wait.Stop()
	select {
	case allow := <-answer:
		if !allow {
			return protocol.LanPaired{}, protocol.LanRefused{Reason: "主人没让这台设备进来"}
		}
		return l.addDevice(name)
	case <-wait.C:
		l.callOff(p)
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "主人没来得及点头，配对码过期了：回那台电脑上换一个码"}
	case <-ctx.Done():
		l.callOff(p)
		return protocol.LanPaired{}, ctx.Err()
	}
}

// Unless the owner has answered or a new pairing replaced it.
func (l *Service) callOff(p *lanPairing) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.pairing == p {
		l.pairing = nil
	}
}

func (l *Service) addDevice(name string) (protocol.LanPaired, error) {
	key := lanKey()
	d := &lanDevice{LanDevice: protocol.LanDevice{ID: "d" + base.Code(8), Name: name, PairedAt: l.now().UnixMilli()}, keyHash: lanHash(key)}
	if err := l.q.AddLanDevice(context.Background(), generated.AddLanDeviceParams{ID: d.ID, Name: d.Name, KeyHash: d.keyHash, PairedAt: d.PairedAt}); err != nil {
		return protocol.LanPaired{}, err
	}
	l.mu.Lock()
	l.devices[d.ID] = d
	l.mu.Unlock()
	log.Printf("vibevalley: the yard gate: %q paired", name)
	return protocol.LanPaired{Device: d.ID, Key: key, Farm: lanFarmName()}, nil
}

func (l *Service) Forget(id string) (protocol.LanStatus, error) {
	if err := l.q.RemoveLanDevice(context.Background(), id); err != nil {
		return protocol.LanStatus{}, err
	}
	l.mu.Lock()
	delete(l.devices, id)
	for _, cancel := range l.conns[id] {
		cancel()
	}
	delete(l.conns, id)
	l.mu.Unlock()
	return l.Status(), nil
}

func (l *Service) Me(ctx context.Context) (protocol.LanDevice, error) {
	id, _ := ctx.Value(lanDeviceKey{}).(string)
	l.mu.Lock()
	defer l.mu.Unlock()
	if d := l.devices[id]; d != nil {
		return d.LanDevice, nil
	}
	return protocol.LanDevice{}, protocol.LanRefused{Reason: "这里就是农场本机，不是经院门来的设备"}
}

// Only what api.go marks vibevalley:can remote, and the two streams, which are not Handlers.
func (l *Service) gate(inner http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if r.Method == http.MethodPost && path == "/api/gate/pair" {
			inner.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(path, "/api/") {
			http.NotFound(w, r)
			return
		}
		d := l.deviceOf(r.Header.Get("Authorization"))
		if d == "" {
			lanRefuse(w, http.StatusUnauthorized, "这台设备没配对，或者已经被主人移除了：回那台电脑上扫码配对")
			return
		}
		if !remoteMay(r) {
			lanRefuse(w, http.StatusForbidden, "院门不放这个：只能在农场那台电脑上做")
			return
		}
		ctx, done := l.track(r.Context(), d)
		defer done()
		inner.ServeHTTP(w, r.WithContext(context.WithValue(ctx, lanDeviceKey{}, d)))
	})
}

func (l *Service) deviceOf(header string) string {
	key, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || key == "" {
		return ""
	}
	hash := lanHash(key)
	now := l.now().UnixMilli()
	l.mu.Lock()
	var found *lanDevice
	for _, d := range l.devices {
		if subtle.ConstantTimeCompare([]byte(d.keyHash), []byte(hash)) == 1 {
			found = d
		}
	}
	if found == nil {
		l.mu.Unlock()
		return ""
	}
	found.LastSeen = &now
	write := now-found.written >= lanSeenEvery.Milliseconds()
	if write {
		found.written = now
	}
	id := found.ID
	l.mu.Unlock()
	if write {
		if err := l.q.SeenLanDevice(context.Background(), generated.SeenLanDeviceParams{LastSeen: sql.NullInt64{Int64: now, Valid: true}, ID: id}); err != nil {
			log.Printf("vibevalley: the yard gate: %v", err)
		}
	}
	return id
}

func (l *Service) track(ctx context.Context, device string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	l.mu.Lock()
	l.next++
	n := l.next
	if l.conns[device] == nil {
		l.conns[device] = map[int]context.CancelFunc{}
	}
	l.conns[device][n] = cancel
	l.mu.Unlock()
	return ctx, func() {
		cancel()
		l.mu.Lock()
		delete(l.conns[device], n)
		l.mu.Unlock()
	}
}

func lanRefuse(w http.ResponseWriter, status int, reason string) {
	body, _ := json.Marshal(protocol.LanRefused{Reason: reason})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}

// Wi-Fi or Ethernet (en*, eth*, wlan*) before others.
func lanAddress() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	best, rank := "", 3
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		r := 2
		for _, p := range []string{"en", "eth", "wlan", "wl"} {
			if strings.HasPrefix(iface.Name, p) {
				r = 1
			}
		}
		if r >= rank {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() {
				best, rank = n.IP.String(), r
				break
			}
		}
	}
	return best
}

func lanFarmName() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "vibevalley"
	}
	return strings.TrimSuffix(name, ".local")
}

func lanDeviceName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if r := []rune(name); len(r) > 40 {
		name = string(r[:40])
	}
	if name == "" {
		return "一台设备"
	}
	return name
}

func lanKey() string {
	raw := make([]byte, 32)
	rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func lanHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// remoteRoutes matches the endpoints a device may call; a request it has no pattern for is refused.
var remoteRoutes = func() *http.ServeMux {
	mux := http.NewServeMux()
	ok := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	for _, e := range protocol.Endpoints {
		if slices.Contains(e.Can, protocol.CallerRemote) {
			mux.Handle(e.Method+" "+e.Path, ok)
		}
	}
	mux.Handle("GET /api/state", ok)
	mux.Handle("GET /api/events", ok)
	return mux
}()

func remoteMay(r *http.Request) bool {
	_, pattern := remoteRoutes.Handler(r)
	return pattern != ""
}
