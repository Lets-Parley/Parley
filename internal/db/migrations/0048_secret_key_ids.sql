-- Which key sealed each secret: a truncated HMAC fingerprint of the key, never
-- the key. Null marks a row sealed before key ids and additional data existed;
-- the boot re-seal pass upgrades it under the current key.
alter table plugin_secrets add column key_id text;
alter table standup_webhooks add column key_id text;
