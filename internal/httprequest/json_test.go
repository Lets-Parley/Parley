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

func TestJSONDecodePolicies(t *testing.T) {
	for _, strict := range []bool{false, true} {
		for _, tc := range []struct {
			body    string
			invalid bool
		}{
			{`{"name":"Ada","extra":true}`, strict},
			{`{"name":"Ada"} {}`, true},
			{`{"name":"Ada"}   `, false},
			{`{"name":"` + strings.Repeat("x", MaxJSONBody) + `"}`, true},
		} {
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			var body struct {
				Name string `json:"name"`
			}
			decode := DecodeJSON
			if strict {
				decode = DecodeStrictJSON
			}
			err := decode(rec, req, MaxJSONBody, &body)
			if (err != nil) != tc.invalid {
				t.Fatalf("strict=%v: error=%v, want invalid=%v", strict, err, tc.invalid)
			}
		}
	}
}
