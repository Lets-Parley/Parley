-- Identity from an OIDC provider. Both columns stay empty for anonymous users,
-- so an instance that never turns auth on is unaffected and an instance that
-- does keeps its old rows readable.
--
-- The pair is what identifies a person, not the subject alone: two providers
-- can hand out the same subject string, and issuer is the only thing that
-- separates them. The partial index leaves anonymous rows out entirely, which
-- is why every one of them can share the empty pair.
alter table users
    add column issuer text not null default '' check (char_length(issuer) <= 255),
    add column subject text not null default '' check (char_length(subject) <= 255);

create unique index users_federated_idx on users (issuer, subject) where issuer <> '';
