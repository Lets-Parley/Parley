-- A link's expiry lives on the session token it mints, not on a garbage
-- collector: hub.validate already re-reads token validity on a ticker and
-- closes the socket when it lapses, so an absolute expiry here buys mid-session
-- severance with no second timer and nothing to sweep.
--
-- Null means "no absolute expiry", which is every ordinary sign-in: those still
-- live and die by the 90-day idle window alone.
alter table session_tokens add column expires_at timestamptz;
