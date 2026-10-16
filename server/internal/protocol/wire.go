// Package protocol is the contract between the server and its client, and the rules over it: the shapes (shapes.go)
// and endpoints (api.go), written once here; what follows from them (gen.go, and the Flutter client's lib/gen, by
// tool/shapegen); and the rules that fold and read the farm's core state.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
)

// withTag marshals v with a union's tag field put first.
func withTag(v any, tag, value string) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	head, err := json.Marshal(map[string]string{tag: value})
	if err != nil {
		return nil, err
	}
	if bytes.Equal(body, []byte("{}")) {
		return head, nil
	}
	return append(append(head[:len(head)-1:len(head)-1], ','), body[1:]...), nil
}

func query(r *http.Request, name string) *string {
	if !r.URL.Query().Has(name) {
		return nil
	}
	v := r.URL.Query().Get(name)
	return &v
}

// decode reads a JSON request body into v, or answers 400 and reports false.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

// StatusError is an error the API answers with its own status and JSON (the generated tagged errors).
type StatusError interface {
	error
	HTTPStatus() int
}

// answer writes a handler's result: the tagged error with its status, 204 for an endpoint with nothing to say
// (out is nil), else 200 with out as JSON (a nil slice as []).
func answer(w http.ResponseWriter, out any, err error) {
	if err != nil {
		var tagged StatusError
		if errors.As(err, &tagged) {
			write(w, tagged.HTTPStatus(), tagged)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if out == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if v := reflect.ValueOf(out); v.Kind() == reflect.Slice && v.IsNil() {
		out = []any{}
	}
	write(w, http.StatusOK, out)
}

func write(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
