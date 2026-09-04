-- Session kinds belong to an org, or to the instance.
--
-- 0034 made a plugin install the property of one org. session_kinds did not
-- follow, which was safe only while nothing could register a kind at runtime:
-- the rows were seeded by migrations and every one of them was core. A plugin
-- that provides a ceremony changes that, and without an owner on the kind, one
-- org's install would offer its rooms to every org on the instance and its
-- sessions — created in somebody else's space — would block its owner's own
-- uninstall.
--
-- Nullable, and NULL means instance-wide. The two core kinds are exactly that:
-- poker and standup belong to no org and must stay available to all of them,
-- so leaving their rows alone is the backfill. A plugin-provided row is written
-- with the installing org's id, so "whose kind is this" has an answer for every
-- row that needs one and no answer invented for the rows that do not.
--
-- ON DELETE CASCADE rather than RESTRICT, unlike sessions.kind. It is not that
-- an org delete sweeps the kind rows up on its way past: spaces.org_id is
-- RESTRICT and sessions.kind is RESTRICT, so an org that still holds a space
-- cannot be deleted at all and the cascade never runs. It is reachable only
-- for an org with nothing left in it, and there RESTRICT would be the wrong
-- answer — a retired kind row nobody references would block the delete
-- forever, and a kind row naming an owner that no longer exists is worse than
-- no row. So: the outcome is that an org holding rooms aborts the delete, and
-- an emptied org takes its own kind rows with it.
alter table session_kinds
    add column org_id uuid references orgs (id) on delete cascade;

-- Every row needs an owner except the instance's own. NULL is reserved for the
-- core kinds, and it has to be reserved rather than merely conventional: every
-- org-matched query below and in internal/plugin joins on org_id, and SQL
-- equality never matches NULL, so a plugin row that slipped in without an org
-- would be un-retirable, would not block its install's uninstall, and would
-- stay on offer to every org on the instance. Nothing writes such a row today.
-- The constraint is what keeps that true.
--
-- It is a biconditional rather than an implication, and the direction that is
-- easy to leave out is the one that matters most: "org_id is not null or
-- provider = 'core'" still admits a row with provider 'core' and a NULL org
-- written by anybody at all, which is an instance-wide ceremony minted outside
-- the core — on offer to every org, owned by none, and un-retirable by the
-- install that wrote it. NULL means the instance and 'core' means the instance,
-- so the constraint says exactly that: each one holds if and only if the other
-- does. poker and standup satisfy it (provider 'core', no org) and every
-- plugin-provided row satisfies it the other way.
alter table session_kinds
    add constraint session_kinds_org_required
    check ((provider = 'core') = (org_id is null));

-- Every offerable-kinds read is "what may this org create", so it is the org
-- that is filtered on.
create index session_kinds_org_id_idx on session_kinds (org_id);

-- A plugin name is unique inside an org, so two orgs can install the same
-- plugin. The kind name is the primary key and stays instance-wide: sessions.
-- kind is a foreign key to it, and a room resolves its kind without knowing
-- which org it belongs to. Two orgs installing the same ceremony plugin
-- therefore collide on the kind name, and the second install is refused rather
-- than quietly taking over the first org's rooms. Making the kind name per-org
-- means a composite key on sessions, which is a much larger change than this
-- one, and is worth doing when a second org actually wants the same plugin.

-- What a plugin-provided kind's actions are, so the dispatch table survives a
-- restart. A core kind's actions are Go code and this stays empty for them.
-- The rows are declared by an untrusted manifest and are screened on
-- registration: session.Registry refuses an action answering GET or HEAD,
-- because the cross-site guard exempts those verbs and every action is a write.
alter table session_kinds
    add column actions jsonb not null default '[]'::jsonb;
