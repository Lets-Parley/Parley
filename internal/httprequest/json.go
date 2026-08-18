package httprequest

import (
	"encoding/json"
	"errors"
	"net/http"
)

const MaxJSONBody = 64 << 10

func DecodeJSON(w http.ResponseWriter, r *http.Request, limit int64, into any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, limit)).Decode(into)
}

func WriteDecodeError(w http.ResponseWriter, err error, fallback string) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		http.Error(w, `{"error":"request body is too large"}`, http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, fallback, http.StatusBadRequest)
}
