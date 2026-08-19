package httprequest

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

const MaxJSONBody = 64 << 10

func DecodeJSON(w http.ResponseWriter, r *http.Request, limit int64, into any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if err := decoder.Decode(into); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return err
	}
	return fmt.Errorf("request body contains more than one JSON document")
}

func WriteDecodeError(w http.ResponseWriter, err error, fallback string) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		http.Error(w, `{"error":"request body is too large"}`, http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, fallback, http.StatusBadRequest)
}
