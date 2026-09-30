-- An org admin's values for the settings a plugin's manifest declares.
--
-- Only the non-secret values live here. A setting declared "format":"secret"
-- is stored encrypted in plugin_secrets under its own name, like any other
-- plugin secret, and never appears in this column.
alter table plugin_installs
    add column settings jsonb not null default '{}';
