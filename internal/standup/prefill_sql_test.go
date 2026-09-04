package standup

import (
	"strings"
	"testing"
)

func TestYesterdayPrefillBreaksCreatedAtTiesOnIdDesc(t *testing.T) {
	if !strings.Contains(yesterdayPrefill, "order by ps.created_at desc, ps.id desc") {
		t.Fatal("yesterdayPrefill must break a shared created_at on id desc")
	}
}
