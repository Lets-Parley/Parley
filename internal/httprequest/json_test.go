package httprequest

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSONRejectsTrailingDocument(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"Ada"} {"name":"Grace"}`))
	rec := httptest.NewRecorder()
	var body struct {
		Name string `json:"name"`
	}

	if err := DecodeJSON(rec, req, MaxJSONBody, &body); err == nil {
		t.Fatal("second JSON document was accepted")
	}
}

func TestDecodeJSONAllowsTrailingWhitespace(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{\"name\":\"Ada\"} \n\t"))
	rec := httptest.NewRecorder()
	var body struct {
		Name string `json:"name"`
	}

	if err := DecodeJSON(rec, req, MaxJSONBody, &body); err != nil {
		t.Fatal(err)
	}
	if body.Name != "Ada" {
		t.Fatalf("name = %q, want Ada", body.Name)
	}
}
