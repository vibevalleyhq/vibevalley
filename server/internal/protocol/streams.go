package protocol

// Stream is a long-lived SSE route. It is not a Handler: it does not answer one request. The handler and the lan listener both
// mount it from this table, so a new stream cannot be added to one and forgotten in the other.
type Stream struct {
	Name string
	Path string
	Can  []Caller
}

var Streams = []Stream{
	{Name: "state", Path: StatePath, Can: []Caller{CallerOwner, CallerRemote}},
	{Name: "events", Path: EventsPath, Can: []Caller{CallerOwner, CallerRemote}},
	{Name: "live", Path: LivePath, Can: []Caller{CallerOwner, CallerRemote}},
}
