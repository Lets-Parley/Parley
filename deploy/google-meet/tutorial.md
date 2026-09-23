# Set up the Parley Meet add-on

**Time to complete**: About 5 minutes

This tutorial registers the Parley add-on for Google Meet in your own Google
Cloud project. It runs `setup.sh`, which scripts everything the Workspace
add-ons API exposes; App configuration, the consent screen, the Store
listing and rolling it out have no API and stay manual console clicks,
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

The script prints these remaining steps and their console URLs:

1. Marketplace SDK **App configuration**:
   - **App Integrations**: tick only "Google Workspace add-on" ("At least
     one integration must be enabled"), then set "Deploy using cloud
     deployment resource" to `parley`. Leave "Web app" unticked — it needs
     96x96 and 48x48 icons a Meet add-on doesn't, which is why those two
     sizes in the kit below are optional.
   - **Developer Information**: pick your own [Trader
     status](https://developers.google.com/workspace/marketplace/enable-configure-sdk)
     (an EEA consumer-protection declaration — yours, not ours). Developer
     Name, Developer Website URL (your `BASE_URL`) and Developer Email are
     required; Application Website URL is optional.
   - **App Visibility**: defaults to **Public**. Switch it to **Private**
     before saving — this cannot be changed once saved.
   - **Installation Settings**: choose **Individual + Admin Install**, not
     **Admin Only Install** — the latter removes one of your two options in
     step 4 below.

   The red "The OAuth Consent Screen must be enabled for this project"
   banner shows here too, and any yellow "user type is testing" banner —
   neither blocks Save on this page. You do need the consent screen before
   you can Publish the Store listing, though: that's next.
2. **Google Auth Platform** (the consent screen), on the same project:
   [console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview).
   Click **Get started**: App name `Parley`, User support email = yours;
   Audience = **Internal** (your own organization only, no Google
   verification); Contact information = your email; agree; **Create**. Add
   no scopes — Parley asks for none. This minimal, Internal consent screen
   is enough.
3. Back on the Marketplace SDK's **Store listing** tab
   ([Create a store listing](https://developers.google.com/workspace/marketplace/create-listing)):
   **Required** — the App Details language entry (its row starts
   collapsed, showing "English —"; click it to expand **Edit Language**,
   fill in Language, Application Name, Short Description and Detailed
   Description, then click **Done**), Category, Application Icon 32x32,
   Application Icon 128x128, Application Card Banner 220x140, at least one
   Screenshot, Terms of service URL, Privacy policy URL, Support URL, and
   Regions (or tick "All Regions"). **Optional** — Pricing, Icon 48x48,
   Icon 96x96, YouTube promo videos, Setup URL, Admin config URL, Help URL,
   Report issue URL, Draft testers. `deploy/google-meet/listing/` has
   ready-made icons, a card banner, screenshots and paste-ready text
   (including the language-entry fields and a category) for all of this
   except the Terms of service, Privacy policy, Support and Regions
   choices, which have to be your own. Click **Save draft** first, then
   **Publish** — Publish stays disabled until Save draft has been clicked
   once, and both stay greyed out until every required field is filled,
   including the hidden language row and step 2's consent screen. A
   **Private** app publishes immediately, with no Google review, but
   nobody can install it until this step is done. Google then shows the
   app's own Marketplace page; its link is whatever the console gives you.
4. Roll it out, either way:
   - **Easiest**: a Workspace admin opens the app's Marketplace page (the
     link Publish just showed you) and clicks **Admin install** to install
     it for the whole domain, or for chosen organizational units.
   - **Or** let people install it themselves: turn on, once per domain,
     "Allow users to install any internal app" in the Google Admin console
     (**Apps → Google Workspace Marketplace apps → Settings**), then your
     people click **Individual install** on the app's page or find it at
     [workspace.google.com/marketplace/mydomainapps](https://workspace.google.com/marketplace/mydomainapps).

Once App configuration, the consent screen and the Store listing are done,
start a call at meet.google.com and open **Meeting tools → Your add-ons**
to try Parley yourself.
