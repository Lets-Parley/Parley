package plugin

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
)

// The frozen ABI schema and the host functions a guest is linked against are
// one list. A host function missing from sdk/abi/v1.json is one the SDK cannot
// type; one listed there and not here is a link error in every guest using it.
func TestHostFunctionsMatchTheFrozenABI(t *testing.T) {
	raw, err := os.ReadFile("../../sdk/abi/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var abi struct {
		HostFunctions []struct{ Name string } `json:"hostFunctions"`
	}
	if err := json.Unmarshal(raw, &abi); err != nil {
		t.Fatal(err)
	}
	var want, got []string
	for _, f := range abi.HostFunctions {
		want = append(want, f.Name)
	}
	for _, f := range (&Host{}).hostFunctions("install") {
		got = append(got, f.Name)
	}
	sort.Strings(want)
	sort.Strings(got)
	if len(want) == 0 || !equalStrings(want, got) {
		t.Fatalf("sdk/abi/v1.json lists %v; the host registers %v", want, got)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
