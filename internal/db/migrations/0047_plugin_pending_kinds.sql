-- A widening upgrade used to write its session kinds before anyone approved
-- it, so the ceremony a pending version declared went live under the grants of
-- the version still running. The kinds are staged here beside the pending
-- grants instead, and ApproveUpgrade applies them in the version bump's own
-- transaction. NULL means the upgrade carried no kind declaration at all.
alter table plugin_installs add column pending_kinds jsonb;
