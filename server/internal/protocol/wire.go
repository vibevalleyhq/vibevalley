// Package protocol is the contract between the server and its client and the rules over it. Shapes and endpoints are written once here; tool/shapegen
// writes gen.go and the Flutter client's lib/gen from them.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
)

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

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

type StatusError interface {
	error
	HTTPStatus() int
}

// 204 when out is nil; a nil slice is written as [].
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
