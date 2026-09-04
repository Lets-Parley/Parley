package plugin

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/lets-parley/parley/internal/session"
)

// exportCSV renders a plugin kind's export from the WIRE envelope. The kind's
// StateFunc is already the client-safe projection, so this cannot invent
// fields the guest did not put on the envelope.
func exportCSV(env session.Envelope) ([][]string, error) {
	state, err := stateObject(env.State)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(state))
	for k := range state {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	header := []string{"id", "kind", "title", "phase"}
	for _, k := range keys {
		header = append(header, session.SanitizeCell(k))
	}
	row := []string{
		session.SanitizeCell(env.ID),
		session.SanitizeCell(env.Kind),
		session.SanitizeCell(env.Title),
		session.SanitizeCell(env.Phase),
	}
	for _, k := range keys {
		row = append(row, session.SanitizeCell(cellString(state[k])))
	}
	return [][]string{header, row}, nil
}

func stateObject(v any) (map[string]any, error) {
	switch t := v.(type) {
	case nil:
		return map[string]any{}, nil
	case map[string]any:
		return t, nil
	case json.RawMessage:
		if len(t) == 0 {
			return map[string]any{}, nil
		}
		var m map[string]any
		if err := json.Unmarshal(t, &m); err != nil {
			return map[string]any{"state": json.RawMessage(t)}, nil
		}
		return m, nil
	default:
		raw, err := json.Marshal(t)
		if err != nil {
			return nil, fmt.Errorf("reading plugin export state: %w", err)
		}
		return stateObject(json.RawMessage(raw))
	}
}

func cellString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}
