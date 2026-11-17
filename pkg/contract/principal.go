package contract

// PrincipalKind identifies who opened a multiplexed Chord link or outgoing proxy request.
type PrincipalKind string

const (
	PrincipalUserDevice   PrincipalKind = "user_device"
	PrincipalMachineNode  PrincipalKind = "machine_node"
	PrincipalSessionToken PrincipalKind = "session_token"
)

// Principal binds authenticated identity, capability scopes, and allowed egress hosts.
type Principal struct {
	Kind         PrincipalKind `json:"kind"`
	ID           string        `json:"id"`
	SessionID    string        `json:"sessionId,omitempty"`
	Capabilities []string      `json:"capabilities,omitempty"`
	AllowedHosts []string      `json:"allowedHosts,omitempty"`
	ExpiresAtMs  int64         `json:"expiresAtMs,omitempty"`
}
