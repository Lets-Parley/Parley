-- Plugin installs belong to an org.
--
-- Until now plugin_installs carried no org at all and `name` was unique across
-- the whole instance, so every lookup the administration surface makes — by id
-- or by name — resolved against every install on the box. The admin gate in
-- front of those routes resolves the {slug} in the *caller's own* path, which
-- proves only that they administer *an* org: an admin of any org could list,
-- disable, upgrade and uninstall another org's plugin, destroying its
-- key-value store and its unrecoverable encrypted secrets, with the audit row
-- landing in the attacker's log rather than the victim's.
--
-- Ownership is the fix. The column is what makes "this install is not yours"
-- expressible at all; scoping every lookup to it is what makes a foreign id
-- indistinguishable from an id that does not exist.

-- Two steps rather than a DEFAULT. The column is added nullable, backfilled,
-- and only then made NOT NULL: adding a NOT NULL column with no default to a
-- populated table is rejected outright, and any install that exists today was
-- necessarily made through the default org's own administration surface, so
-- that is where it belongs.
alter table plugin_installs add column org_id uuid references orgs (id) on delete cascade;

update plugin_installs set org_id = '00000000-0000-0000-0000-000000000001' where org_id is null;

alter table plugin_installs alter column org_id set not null;

-- Deliberately no retained DEFAULT, unlike spaces.org_id in 0021_orgs.sql.
-- There the default existed so a replica still running the previous binary
-- could keep inserting spaces through a rolling update. An insert is the
-- difference: a space is created constantly by ordinary users, while an
-- install is a rare deliberate operator action. A default here would mean a
-- caller that forgot the org silently files its install under the default org
-- — the exact cross-org misattribution this migration exists to remove — so a
-- write that does not name an org fails loudly instead.

-- A plugin name is a name inside one org, not across the instance. Two orgs
-- installing the same plugin are two installs with two separate key-value
-- stores and two separate secrets, which is the only reading of "installed"
-- that is true once installs are owned.
alter table plugin_installs drop constraint plugin_installs_name_key;
alter table plugin_installs add constraint plugin_installs_org_id_name_key unique (org_id, name);

-- The administration surface lists one org's installs on every page load.
create index plugin_installs_org_id_idx on plugin_installs (org_id);
