package plugin

import (
	"context"
	"errors"
	"fmt"
)

// ErrQuotaExceeded is returned when a write would take an install past its
// key-value quota. The write does not happen and the counter does not move.
var ErrQuotaExceeded = errors.New("plugin storage quota exceeded")

// Put writes one key in an install's namespace, charging the quota counter in
// the same statement as the write it accounts for.
//
// One statement, not two, because a counter maintained separately from the
// write can drift, and a drifted counter silently grants unbounded storage.
// The counter update is also the quota check: it matches no row when the new
// total would exceed the quota, which leaves the insert with nothing to select
// from, so the refusal and the accounting cannot disagree.
func (s *Store) Put(ctx context.Context, installID, key string, value []byte) error {
	tag, err := s.Pool.Exec(ctx, `
		with delta as (
			select $3::bigint - coalesce(
				(select size_bytes from plugin_kv where install_id = $1 and key = $2), 0) as bytes
		),
		charged as (
			update plugin_installs i
			set kv_bytes = i.kv_bytes + (select bytes from delta)
			where i.id = $1 and i.kv_bytes + (select bytes from delta) <= i.kv_quota_bytes
			returning i.id
		)
		insert into plugin_kv (install_id, key, value, size_bytes)
		select c.id, $2, $4, $3 from charged c
		on conflict (install_id, key) do update
			set value = excluded.value, size_bytes = excluded.size_bytes, updated_at = now()`,
		installID, key, len(value), value)
	if err != nil {
		return fmt.Errorf("writing plugin key %q: %w", key, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("writing plugin key %q: %w", key, ErrQuotaExceeded)
	}
	return nil
}

// Get reads one key. The second return is false when the key is not set.
func (s *Store) Get(ctx context.Context, installID, key string) ([]byte, bool, error) {
	var value []byte
	err := s.Pool.QueryRow(ctx,
		`select value from plugin_kv where install_id = $1 and key = $2`, installID, key).Scan(&value)
	if err != nil {
		if isNoRows(err) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("reading plugin key %q: %w", key, err)
	}
	return value, true, nil
}

// Delete removes one key and credits the counter back in the same statement.
func (s *Store) Delete(ctx context.Context, installID, key string) error {
	_, err := s.Pool.Exec(ctx, `
		with removed as (
			delete from plugin_kv where install_id = $1 and key = $2
			returning size_bytes
		)
		update plugin_installs
		set kv_bytes = greatest(kv_bytes - coalesce((select size_bytes from removed), 0), 0)
		where id = $1 and exists (select 1 from removed)`, installID, key)
	if err != nil {
		return fmt.Errorf("deleting plugin key %q: %w", key, err)
	}
	return nil
}

// ReconcileQuotas resets every counter to what the rows actually add up to and
// returns how many were wrong. The counter is maintained transactionally, so
// this should always find nothing — which is exactly why it is worth running:
// a counter nobody checks is a counter that can drift into granting unbounded
// storage.
func (s *Store) ReconcileQuotas(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `
		update plugin_installs i
		set kv_bytes = actual.bytes
		from (
			select p.id, coalesce(sum(kv.size_bytes), 0)::bigint as bytes
			from plugin_installs p
			left join plugin_kv kv on kv.install_id = p.id
			group by p.id
		) actual
		where i.id = actual.id and i.kv_bytes <> actual.bytes`)
	if err != nil {
		return 0, fmt.Errorf("reconciling plugin storage quotas: %w", err)
	}
	return tag.RowsAffected(), nil
}
