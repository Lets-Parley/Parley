# Set up the Parley Meet add-on

This tutorial registers the Parley add-on for Google Meet in your own Google
Cloud project. It runs `setup.sh`, which scripts everything the Workspace
add-ons API exposes; a few steps have no API and stay manual console clicks,
listed at the end. See the
[operator guide](https://www.letsparley.io/operations/google-meet/) for the
full picture.

## Pick a project

Use an existing project in your Workspace organization, or create one:

```sh
gcloud projects create PROJECT_ID --name="Parley Meet add-on"
gcloud config set project PROJECT_ID
```

Replace `PROJECT_ID` with your own. The rest of this tutorial uses whichever
project is currently selected.

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
deployment named `parley`. It then installs the add-on for your own account
so you can try it from a Meet call.

## Finish the steps with no API

The script prints four remaining steps and their console URLs:

1. Marketplace SDK **App configuration**: App integration = "Google Workspace
   add-on", "Deploy using cloud deployment resource" = `parley`, App
   visibility = **Private**. This cannot be changed once saved.
2. The OAuth consent screen for this project.
3. Optionally, click **Install** on the `parley` deployment for a fresh
   account-level install.
4. To roll it out to your whole Workspace domain, a super administrator
   installs it from the Google Admin console's Marketplace apps list.

Once App configuration and the consent screen are done, start a call at
meet.google.com and open **Meeting tools → Your add-ons** to try Parley.
