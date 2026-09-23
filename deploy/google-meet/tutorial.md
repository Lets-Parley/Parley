# Set up the Parley Meet add-on

**Time to complete**: About 5 minutes

This tutorial registers the Parley add-on for Google Meet in your own Google
Cloud project. It runs `setup.sh`, which scripts everything the Workspace
add-ons API exposes; four steps have no API and stay manual console clicks,
listed at the end. See the
[operator guide](https://www.letsparley.io/operations/google-meet/) for the
full picture.

## Pick a project

<walkthrough-project-setup></walkthrough-project-setup>

The rest of this tutorial uses the project you just picked,
<walkthrough-project-id/>.

## Set your Parley URL

`BASE_URL` is the same `https://` address you set for Parley itself, scheme
and host only, no path and no trailing slash:

```sh
export BASE_URL=https://parley.example.com
```

## Run the setup script

```sh
deploy/google-meet/setup.sh
```

This enables the required services, builds the add-on manifest from
`BASE_URL`, and creates (or, on a re-run, replaces) the Workspace add-ons
deployment named `parley`. It retries for a couple of minutes if a
just-enabled API is still activating, then installs the add-on for your own
account and checks that the install took.

## Finish the steps with no API

The script prints four remaining steps and their console URLs:

1. Marketplace SDK **App configuration**: App integration = "Google Workspace
   add-on", "Deploy using cloud deployment resource" = `parley`, App
   visibility = **Private**, plus your Developer Name, Website (your
   `BASE_URL`) and Email. This cannot be changed once saved. Ignore the red
   "The OAuth Consent Screen must be enabled for this project" banner — it
   saves anyway, and the add-on works without one.
2. On the same page's **Store listing** tab, fill in the required fields —
   Language, Application name, Short description, Detailed description,
   Category, Application icons, Application card banner, Screenshots, Terms
   of service, Privacy policy and Support — then click **Submit**. A
   **Private** app publishes immediately, with no Google review, but nobody
   can install it until this step is done.
3. A super administrator turns on, once per domain, "Allow users to install
   any internal app" in the Google Admin console.
4. Your people install it themselves from
   [workspace.google.com/marketplace/mydomainapps](https://workspace.google.com/marketplace/mydomainapps).

Once App configuration and the Store listing are done, start a call at
meet.google.com and open **Meeting tools → Your add-ons** to try Parley
yourself.
