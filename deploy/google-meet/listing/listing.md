# Store listing text

Paste-ready for the Marketplace SDK's Store listing tab. Limits are quoted
from Google's
[Create a store listing](https://developers.google.com/workspace/marketplace/create-listing)
page (see `README.md`).

Application name, Short description and Detailed description all live
inside the App Details language entry (English), which is itself required.
That row starts collapsed, showing only "English —": click it to expand
**Edit Language**, paste the three texts below plus the Language itself
(English), then click **Done**. Publish and Save draft both stay greyed
out until this row is filled in, along with every other required field.

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
Parley brings planning poker and standups into Google Meet. Anyone with an
account on your Parley instance can open it from Meeting tools -> Your
add-ons, signing in right there from the side panel.

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

Requirements: your people need an account on your Parley instance -- the
side panel signs them in itself, with a short code they type on an
ordinary Parley tab -- and Parley must be served over HTTPS.

External Meet attendees without a Parley account, and view-only attendees,
cannot use the add-on; they keep what they had before, since a facilitator
can still share the presenter view as an ordinary screen share.
```

## Category

Required. Google's create-listing page doesn't list the dropdown's exact
options; these were read from the real dropdown in the console
(2026-09-23): Accounting and Finance, Administration and Management, ERP
and Logistics, HR and Legal, Marketing and Analytics, Sales and CRM,
Creative Tools, Web Development, Office Applications, Task Management,
Academic Resources, Teacher and Admin Tools, Communication, Utilities.

Pick **Task Management**, or **Communication** as the alternative.

## Support links

The store listing also requires Terms of service, Privacy policy and
Support URLs. These have to be the operator's own -- Parley the project has
no hosted legal pages that describe your instance or who supports it. Use:

- **Terms of service** / **Privacy policy**: your organization's own
  policies, or a short page saying Parley is an internal tool run by your
  organization and covered by its existing policies.
- **Support**: an address or page your own people can actually reach --
  your team's support inbox, ticket queue or internal wiki page for Parley.

## Regions

Also required. Tick **All Regions**, or restrict the listing to wherever
your organization actually operates -- there's no ready-made answer here,
it's your own call.
