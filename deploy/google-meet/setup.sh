#!/usr/bin/env bash
# Registers the Parley Meet add-on in the operator's own Google Cloud
# project. Run from the "Open in Cloud Shell" tutorial (tutorial.md) or by
# hand from a clone of this repository. Idempotent: a re-run replaces the
# existing deployment instead of failing.
#
# What this script cannot do — no API exists for these, so they stay manual
# console steps printed at the end: Marketplace SDK App configuration
# (integration type, deployment pointer, visibility, developer contact
# fields — permanent once saved), the OAuth consent screen, the Store
# listing (required before anyone can install the app), and rolling it out
# to the domain.
set -euo pipefail

# Never stop to ask a yes/no question; every gcloud call below is meant to
# run unattended from the tutorial.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

: "${BASE_URL:?set BASE_URL to your Parley instance, e.g. https://parley.example.com}"

# Validated before any gcloud call: https, host only, no path or trailing
# slash. This is the same string the operator already set for Parley itself
# (see site/src/content/docs/operations/google-meet.mdx).
if ! [[ "$BASE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "BASE_URL must be https://host[:port] with no path and no trailing slash (got: $BASE_URL)" >&2
  exit 1
fi

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "no active gcloud project. Run: gcloud config set project PROJECT_ID" >&2
  exit 1
fi

DEPLOYMENT_ID="parley"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
DEPLOYMENT_FILE="$WORK_DIR/deployment.json"

# A just-enabled API keeps rejecting calls for a few seconds while it
# finishes activating — on a fresh project this is what made `describe` look
# hung. That class of failure is a PERMISSION_DENIED or FAILED_PRECONDITION
# naming the API as not yet usable; retry only on that text, with a bounded
# exponential backoff (defaults: up to 6 attempts, 5s/10s/20s/30s/30s between
# them, ~95s total). Anything else — a real permission problem, a bad
# deployment file — returns on the first attempt with gcloud's own message
# intact.
RETRY_MAX_ATTEMPTS="${RETRY_MAX_ATTEMPTS:-6}"
RETRY_INITIAL_DELAY="${RETRY_INITIAL_DELAY:-5}"
ACTIVATION_ERROR_RE='(PERMISSION_DENIED|FAILED_PRECONDITION).*(has not been used|is disabled)'

retry_while_activating() {
  local attempt=1 delay="$RETRY_INITIAL_DELAY"
  local err_file="$WORK_DIR/retry-error"
  local status
  while :; do
    if "$@" 2>"$err_file"; then
      cat "$err_file" >&2
      rm -f "$err_file"
      return 0
    else
      status=$?
    fi
    cat "$err_file" >&2
    if [[ $attempt -ge $RETRY_MAX_ATTEMPTS ]] || ! grep -qE "$ACTIVATION_ERROR_RE" "$err_file"; then
      rm -f "$err_file"
      return "$status"
    fi
    rm -f "$err_file"
    echo "the API is still activating, retrying ($attempt/$RETRY_MAX_ATTEMPTS)..." >&2
    sleep "$delay"
    delay=$(( delay * 2 > 30 ? 30 : delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
}

# 1. Enable the two services a Meet add-on needs.
#    https://cloud.google.com/sdk/gcloud/reference/services/enable
gcloud services enable \
  gsuiteaddons.googleapis.com \
  appsmarket-component.googleapis.com

# 2. Build the manifest from the same template the operator guide's example
#    is copied from (deploy/google-meet/manifest.template.json), substituting
#    the operator's BASE_URL for the placeholder.
sed "s#BASE_URL_PLACEHOLDER#${BASE_URL}#g" "$SCRIPT_DIR/manifest.template.json" >"$DEPLOYMENT_FILE"

# 3. Create the deployment, or replace it if a re-run finds one already
#    there. `--format=none` keeps a successful replace from echoing the
#    whole manifest back. `create` is GA:
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/create
#    `describe` and `replace` are also GA:
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/describe
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/replace
if retry_while_activating gcloud workspace-add-ons deployments describe "$DEPLOYMENT_ID" --format=none; then
  if ! retry_while_activating gcloud workspace-add-ons deployments replace "$DEPLOYMENT_ID" \
    --deployment-file="$DEPLOYMENT_FILE" --format=none; then
    echo "could not replace the existing deployment after retrying; see the error above." >&2
    exit 1
  fi
else
  if ! retry_while_activating gcloud workspace-add-ons deployments create "$DEPLOYMENT_ID" \
    --deployment-file="$DEPLOYMENT_FILE" --format=none; then
    echo "could not create the deployment after retrying; see the error above." >&2
    exit 1
  fi
fi

# 4. Install it for the operator's own account, to test with.
#    https://developers.google.com/workspace/add-ons/reference/rest/v1/projects.deployments/install
gcloud workspace-add-ons deployments install "$DEPLOYMENT_ID" --format=none

# 5. Confirm the install actually took.
#    https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments/install-status
#    The REST resource is { name, installed: bool }; `value(installed)`
#    prints just that field.
INSTALL_STATUS_ERR="$WORK_DIR/install-status-error"
if INSTALLED="$(gcloud workspace-add-ons deployments install-status "$DEPLOYMENT_ID" --format='value(installed)' 2>"$INSTALL_STATUS_ERR")"; then
  if [[ "${INSTALLED,,}" == "true" ]]; then
    INSTALL_LINE="✅ installed for your account."
  else
    INSTALL_LINE="❌ install-status reports it is not installed yet; re-run: gcloud workspace-add-ons deployments install-status ${DEPLOYMENT_ID}"
  fi
else
  cat "$INSTALL_STATUS_ERR" >&2
  INSTALL_LINE="❌ could not confirm the install; see the error above."
fi

# Used only to guess the app's future Marketplace page link below; a
# failure here is not fatal, it just drops that one line.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true)"
MARKETPLACE_PAGE_LINE=""
if [[ -n "$PROJECT_NUMBER" ]]; then
  MARKETPLACE_PAGE_LINE="
     If you kept the Application Name \"Parley\", it should end up at
     https://workspace.google.com/marketplace/app/parley/${PROJECT_NUMBER}
     — Google shows the exact link once you publish, so treat this as a
     guess, not the source of truth."
fi

cat <<EOF

Scripted steps done for project ${PROJECT_ID}. ${INSTALL_LINE}

Four steps have no API and stay manual:

  1. APIs & Services -> Google Workspace Marketplace SDK -> App configuration:
     - App Integrations: tick only "Google Workspace add-on" ("At least one
       integration must be enabled"), then set "Deploy using cloud
       deployment resource" to ${DEPLOYMENT_ID}. Leave "Web app" unticked —
       it needs 96x96 and 48x48 icons that a Meet add-on doesn't, which is
       why those two sizes in the kit are optional.
     - Developer Information: pick your own Trader status (required) —
       this is your own EEA consumer-protection declaration, not ours; see
       https://developers.google.com/workspace/marketplace/enable-configure-sdk.
       Developer Name, Developer Website URL (your BASE_URL, ${BASE_URL})
       and Developer Email are required; Application Website URL is
       optional.
     - App Visibility: defaults to Public. Switch it to Private before
       saving — it cannot be changed afterward.
     - Installation Settings: choose "Individual + Admin Install", not
       "Admin Only Install" — the latter removes one of your two options
       in step 4 below.
     The red "The OAuth Consent Screen must be enabled for this project"
     banner shows here too, and any yellow "user type is testing" banner —
     neither blocks Save on this page. You do need the consent screen
     before you can Publish the Store listing, though: that's step 2.
     https://console.cloud.google.com/apis/api/appsmarket-component.googleapis.com/googleapps_sdk?project=${PROJECT_ID}
  2. Google Auth Platform (the consent screen), same project:
     https://console.cloud.google.com/auth/overview?project=${PROJECT_ID}
     -> Get started -> App name "Parley", User support email = yours ->
     Audience: Internal (your own organization only, no Google
     verification) -> Contact information = your email -> agree -> Create.
     Add no scopes; Parley requests none. This minimal, Internal consent
     screen is enough.
  3. Back on the Marketplace SDK, Store listing tab
     (https://developers.google.com/workspace/marketplace/create-listing).
     Required: the App Details language entry (its row starts collapsed,
     showing "English -"; click it to expand "Edit Language", fill
     Language, Application Name, Short Description and Detailed
     Description, then click Done), Category, Application Icon 32x32,
     Application Icon 128x128, Application Card Banner 220x140, at least
     one Screenshot, Terms of service URL, Privacy policy URL, Support URL,
     and Regions (or tick "All Regions"). Optional: Pricing, Icon 48x48,
     Icon 96x96, YouTube promo videos, Setup URL, Admin config URL, Help
     URL, Report issue URL, Draft testers. deploy/google-meet/listing/ has
     ready-made icons, a card banner, screenshots and paste-ready text
     (including the language-entry fields and a category) for all of this
     except the Terms of service, Privacy policy, Support and Regions
     choices, which have to be your own (see its README.md). Click Save
     draft first, then Publish — Publish stays disabled until Save draft
     has been clicked once, and both stay greyed out until every required
     field is filled, including the hidden language row and step 2's
     consent screen. A Private app publishes immediately, with no Google review
     — but it is not installable by anyone until this step is
     done.${MARKETPLACE_PAGE_LINE}
  4. Roll it out, either way:
       - Easiest: a Workspace admin opens the app's Marketplace page (the
         link Publish just showed you) and clicks "Admin install" to
         install it for the whole domain, or for chosen organizational units
         (https://support.google.com/a/answer/172482).
       - Or let people install it themselves: turn on, once per domain,
         Admin console -> Apps -> Google Workspace Marketplace apps ->
         Settings -> "Allow users to install any internal app", then your
         people click "Individual install" on the app's page or find it at
         https://workspace.google.com/marketplace/mydomainapps.
EOF
