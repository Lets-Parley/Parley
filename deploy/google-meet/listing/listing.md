# Store listing text

Paste-ready for the Marketplace SDK's Store listing tab. Limits are quoted
from Google's
[Create a store listing](https://developers.google.com/workspace/marketplace/create-listing)
page (see `README.md`).

## Application name

*Limit: 50 characters*

```
Parley
```

## Short description

*Limit: 200 characters*

```
Planning poker and standups inside Google Meet: a side panel to join and vote from, and a main stage the whole call can watch.
```

## Detailed description

*Limit: less than 16,000 characters*

```
Parley brings planning poker and standups into Google Meet. Anyone already
signed in to Parley can open it from Meeting tools -> Your add-ons.

The side panel lists your Parley spaces and open rooms, joins a room with
its passcode, and gives a poker room a compact vote pad. For a standup, it
links out to the room in a browser tab.

A poker room's facilitator can also click "Show on main stage" to put the
presenter view up for everyone in the call who has the add-on.

The add-on is published privately by your own Google Workspace: there is no
public listing and no Google review beyond your own store listing
submission. It runs entirely inside your own Google Cloud project and your
own Parley instance -- nothing reaches Parley's maintainers, and Parley asks
Google for no OAuth scopes.

Requirements: your people must already be able to sign in to Parley in the
same browser Meet is running in, and Parley must be served over HTTPS.

External Meet attendees, anyone not signed in to Parley, and view-only
attendees cannot use the add-on; they keep what they had before, since a
facilitator can still share the presenter view as an ordinary screen share.
```

## Category

Google's create-listing page does not list the category dropdown's exact
options, so this is a suggestion to look for, not a verified label:
**Productivity**.

## Support links

The store listing also asks for Terms of service, Privacy policy and
Support URLs. These have to be the operator's own -- Parley the project has
no hosted legal pages that describe your instance or who supports it. Use:

- **Terms of service** / **Privacy policy**: your organization's own
  policies, or a short page saying Parley is an internal tool run by your
  organization and covered by its existing policies.
- **Support**: an address or page your own people can actually reach --
  your team's support inbox, ticket queue or internal wiki page for Parley.
