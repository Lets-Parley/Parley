---
title: Sign-in
description: Run Parley with no accounts at all, or hand identity to your own OpenID Connect provider.
---

Parley runs in one of two modes, set by `AUTH_MODE` and fixed at boot.

## open

The default, and the original. No accounts: people type a name, get an avatar,
and take a seat. Nothing to administer, nothing to provision. A stranger with
the link and the room code is a participant.

## oidc

Sign-in goes to your identity provider. There is no vendor-specific code in
Parley — it is a plain OpenID Connect relying party that reads the issuer's
discovery document, so anything speaking OIDC works and switching providers is
a change of configuration:

```sh
AUTH_MODE=oidc
OIDC_ISSUER=https://keycloak.example.com/realms/yourteam
OIDC_CLIENT_ID=parley
OIDC_CLIENT_SECRET=...
```

Register `<BASE_URL>/auth/callback` as the redirect URI with your provider, and
allow the `openid`, `profile` and `email` scopes.

Sign-in uses the authorization code flow with PKCE. The ID token's signature,
audience, expiry and nonce are all verified before an account is touched.

:::caution[Two things to know before switching a running instance]
**The anonymous door closes.** With a provider configured, the endpoint that
mints a nameless identity is refused outright — otherwise signing in would be
optional and therefore pointless.

**Everyone is signed out.** Sessions created while the instance was open stop
being accepted the moment it starts in `oidc` mode. Accounts and rooms stay in
the database, untouched and unmigrated, but the people behind them come back as
new federated accounts. Plan the switch for an instance whose history you're
willing to leave behind, or wait for account linking.
:::

## Names

Taken from the provider's claims — `name`, then `preferred_username`, then the
local part of `email` — and refreshed on every sign-in, so a rename upstream
follows the person onto the roster.

## Signing out

Ends the Parley session only. It does not sign anyone out of the identity
provider, which matters on a shared machine.

## Room codes still apply

Identity says who you are. The room code says which room you may enter. Signing
in does not by itself get anyone into a space — per-user and per-team access is
on the roadmap.
