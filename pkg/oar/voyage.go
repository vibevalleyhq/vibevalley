package oar

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var (
	// ErrInvalidVoyageHeader indicates a stream does not begin with a valid oar-voyage/3 header.
	ErrInvalidVoyageHeader = errors.New("oar: invalid or unsupported voyage header")
	// ErrNonMonotonicSeq indicates a RecordEnvelope sequence number decreased or repeated.
	ErrNonMonotonicSeq = errors.New("oar: record sequence number must strictly increase")
)

// VoyageHeader is written as the first line of an oar-voyage/3 JSONL recording.
type VoyageHeader struct {
	Format    string            `json:"format"`
	Version   int               `json:"version"`
	Runtime   string            `json:"runtime,omitempty"`
	SessionID string            `json:"sessionId,omitempty"`
	CreatedAt int64             `json:"createdAt,omitempty"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// VoyageEncoder writes an oar-voyage/3 header followed by validated RecordEnvelope JSON lines.
type VoyageEncoder struct {
	w       io.Writer
	wrote   bool
	lastSeq int64
}

// NewVoyageEncoder writes the oar-voyage/3 header immediately and returns an encoder for records.
func NewVoyageEncoder(w io.Writer, header VoyageHeader) (*VoyageEncoder, error) {
	if w == nil {
		return nil, errors.New("oar: nil voyage writer")
	}
	if header.Format == "" {
		header.Format = VoyageFormat
	}
	if header.Format != VoyageFormat {
		return nil, fmt.Errorf("%w: got %q, want %q", ErrInvalidVoyageHeader, header.Format, VoyageFormat)
	}
	if header.Version == 0 {
		header.Version = VoyageVersion
	}
	if header.Version != VoyageVersion {
		return nil, fmt.Errorf("%w: got version %d, want %d", ErrInvalidVoyageHeader, header.Version, VoyageVersion)
	}
	line, err := json.Marshal(header)
	if err != nil {
		return nil, fmt.Errorf("oar: marshal voyage header: %w", err)
	}
	line = append(line, '\n')
	if _, err := w.Write(line); err != nil {
		return nil, fmt.Errorf("oar: write voyage header: %w", err)
	}
	return &VoyageEncoder{w: w, lastSeq: -1}, nil
}

// Write validates and appends one RecordEnvelope line to the oar-voyage/3 stream.
func (e *VoyageEncoder) Write(rec RecordEnvelope) error {
	if err := rec.Validate(); err != nil {
		return err
	}
	if e.wrote && rec.Seq <= e.lastSeq {
		return fmt.Errorf("%w: got %d after %d", ErrNonMonotonicSeq, rec.Seq, e.lastSeq)
	}
	line, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("oar: marshal record seq %d: %w", rec.Seq, err)
	}
	line = append(line, '\n')
	if _, err := e.w.Write(line); err != nil {
		return fmt.Errorf("oar: write record seq %d: %w", rec.Seq, err)
	}
	e.wrote = true
	e.lastSeq = rec.Seq
	return nil
}

// VoyageDecoder reads and validates an oar-voyage/3 JSONL stream line by line without fixed line-size caps.
type VoyageDecoder struct {
	r       *bufio.Reader
	header  VoyageHeader
	readAny bool
	lastSeq int64
}

// NewVoyageDecoder parses and validates the opening oar-voyage/3 header line.
func NewVoyageDecoder(r io.Reader) (*VoyageDecoder, error) {
	if r == nil {
		return nil, errors.New("oar: nil voyage reader")
	}
	br := bufio.NewReaderSize(r, 64*1024)
	line, err := readNonEmptyLine(br)
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("%w: empty stream", ErrInvalidVoyageHeader)
		}
		return nil, fmt.Errorf("oar: read voyage header: %w", err)
	}
	var hdr VoyageHeader
	if err := json.Unmarshal(line, &hdr); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidVoyageHeader, err)
	}
	if hdr.Format != VoyageFormat || (hdr.Version != 0 && hdr.Version != VoyageVersion) {
		return nil, fmt.Errorf("%w: format=%q version=%d", ErrInvalidVoyageHeader, hdr.Format, hdr.Version)
	}
	if hdr.Version == 0 {
		hdr.Version = VoyageVersion
	}
	return &VoyageDecoder{
		r:       br,
		header:  hdr,
		lastSeq: -1,
	}, nil
}

// Header returns the decoded oar-voyage/3 stream header.
func (d *VoyageDecoder) Header() VoyageHeader {
	return d.header
}

// Next decodes and validates the next RecordEnvelope, returning io.EOF at the end of the stream.
func (d *VoyageDecoder) Next() (RecordEnvelope, error) {
	line, err := readNonEmptyLine(d.r)
	if err != nil {
		return RecordEnvelope{}, err
	}
	var rec RecordEnvelope
	if err := json.Unmarshal(line, &rec); err != nil {
		return RecordEnvelope{}, fmt.Errorf("oar: decode record: %w", err)
	}
	if err := rec.Validate(); err != nil {
		return RecordEnvelope{}, err
	}
	if d.readAny && rec.Seq <= d.lastSeq {
		return RecordEnvelope{}, fmt.Errorf("%w: got %d after %d", ErrNonMonotonicSeq, rec.Seq, d.lastSeq)
	}
	d.readAny = true
	d.lastSeq = rec.Seq
	return rec, nil
}

// EncodeVoyage writes a complete oar-voyage/3 stream containing header and records.
func EncodeVoyage(w io.Writer, header VoyageHeader, records []RecordEnvelope) error {
	enc, err := NewVoyageEncoder(w, header)
	if err != nil {
		return err
	}
	for _, rec := range records {
		if err := enc.Write(rec); err != nil {
			return err
		}
	}
	return nil
}

// DecodeVoyage reads and validates an entire oar-voyage/3 JSONL stream.
func DecodeVoyage(r io.Reader) (VoyageHeader, []RecordEnvelope, error) {
	dec, err := NewVoyageDecoder(r)
	if err != nil {
		return VoyageHeader{}, nil, err
	}
	var out []RecordEnvelope
	for {
		rec, err := dec.Next()
		if errors.Is(err, io.EOF) {
			return dec.Header(), out, nil
		}
		if err != nil {
			return VoyageHeader{}, nil, err
		}
		out = append(out, rec)
	}
}

func readNonEmptyLine(r *bufio.Reader) ([]byte, error) {
	for {
		line, err := r.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			return trimmed, nil
		}
		if err != nil {
			return nil, err
		}
	}
}
