#!/bin/sh
# Exercises deploy/google-meet/setup.sh against a stub gcloud on PATH, since
# a real run needs a live Cloud project. Covers the acceptance criteria from
# issue #661: prompts are disabled, BASE_URL is validated before any gcloud
# call, a first run creates the deployment and a re-run replaces it, a
# just-activating API is retried and either recovers or fails clearly, the
# manifest matches BASE_URL, install-status renders as a checkmark or cross,
# and the printed checklist is the three remaining manual steps only.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
setup="$repo_root/deploy/google-meet/setup.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

stub_bin="$work/bin"
mkdir -p "$stub_bin"
calls_log="$work/calls.log"
capture="$work/deployment-file-content.json"
create_counter="$work/create-counter"

# DESCRIBE_EXIT controls whether the stub's "describe" subcommand reports the
# deployment as already existing (0) or not (1), which is what setup.sh
# branches create vs. replace on. CREATE_FAIL_COUNT makes "create" fail that
# many times first with the exact error text a just-enabled, still-activating
# API produces, before succeeding — REQUIRE_PROMPTS_DISABLED checks setup.sh
# ran gcloud non-interactively. INSTALL_STATUS_VALUE/INSTALL_STATUS_FAIL drive
# the install-status check.
cat > "$stub_bin/gcloud" <<'STUB'
#!/bin/sh
set -eu
echo "$@" >>"$CALLS_LOG"
if [ "${REQUIRE_PROMPTS_DISABLED:-0}" = "1" ] && [ "${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" != "1" ]; then
  echo "CLOUDSDK_CORE_DISABLE_PROMPTS was not set to 1" >&2
  exit 1
fi
case "$1 $2" in
  "config get-value")
    echo "test-project"
    ;;
  "services enable")
    ;;
  "workspace-add-ons deployments")
    sub="$3"
    case "$sub" in
      describe)
        exit "$DESCRIBE_EXIT"
        ;;
      create)
        n=0
        [ -f "$CREATE_COUNTER" ] && n=$(cat "$CREATE_COUNTER")
        n=$((n + 1))
        echo "$n" >"$CREATE_COUNTER"
        if [ "$n" -le "${CREATE_FAIL_COUNT:-0}" ]; then
          echo "${CREATE_ERROR_TEXT:-ERROR: (gcloud.workspace-add-ons.deployments.create) PERMISSION_DENIED: Google Workspace Marketplace SDK API has not been used in project test-project before or it is disabled.}" >&2
          exit 1
        fi
        for arg in "$@"; do
          case "$arg" in
            --deployment-file=*)
              cp "${arg#--deployment-file=}" "$CAPTURE"
              ;;
          esac
        done
        ;;
      replace)
        for arg in "$@"; do
          case "$arg" in
            --deployment-file=*)
              cp "${arg#--deployment-file=}" "$CAPTURE"
              ;;
          esac
        done
        ;;
      install) ;;
      install-status)
        if [ "${INSTALL_STATUS_FAIL:-0}" = "1" ]; then
          echo "ERROR: (gcloud.workspace-add-ons.deployments.install-status) could not reach the API" >&2
          exit 1
        fi
        echo "${INSTALL_STATUS_VALUE:-True}"
        ;;
      *)
        echo "unexpected workspace-add-ons subcommand: $sub" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unexpected gcloud invocation: $*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$stub_bin/gcloud"

run_setup() {
  BASE_URL="$1" DESCRIBE_EXIT="$2" CALLS_LOG="$calls_log" CAPTURE="$capture" \
    CREATE_COUNTER="$create_counter" CREATE_FAIL_COUNT="${CREATE_FAIL_COUNT:-0}" \
    CREATE_ERROR_TEXT="${CREATE_ERROR_TEXT:-}" \
    RETRY_MAX_ATTEMPTS="${RETRY_MAX_ATTEMPTS:-3}" RETRY_INITIAL_DELAY=0 \
    INSTALL_STATUS_VALUE="${INSTALL_STATUS_VALUE:-True}" \
    INSTALL_STATUS_FAIL="${INSTALL_STATUS_FAIL:-0}" \
    REQUIRE_PROMPTS_DISABLED="${REQUIRE_PROMPTS_DISABLED:-0}" \
    PATH="$stub_bin:$PATH" "$setup"
}

# BASE_URL with a path is refused, and refused before gcloud is ever called.
rm -f "$calls_log"
if BASE_URL="https://parley.example.com/meet" DESCRIBE_EXIT=1 CALLS_LOG="$calls_log" \
  CAPTURE="$capture" PATH="$stub_bin:$PATH" "$setup" >"$work/bad.log" 2>&1; then
  echo "FAIL: a BASE_URL with a path should be refused" >&2
  cat "$work/bad.log" >&2
  exit 1
fi
if [ -f "$calls_log" ]; then
  echo "FAIL: a rejected BASE_URL must never reach gcloud" >&2
  cat "$calls_log" >&2
  exit 1
fi

# A plain-HTTP BASE_URL is refused the same way.
rm -f "$calls_log"
if BASE_URL="http://parley.example.com" DESCRIBE_EXIT=1 CALLS_LOG="$calls_log" \
  CAPTURE="$capture" PATH="$stub_bin:$PATH" "$setup" >"$work/http.log" 2>&1; then
  echo "FAIL: a plain-HTTP BASE_URL should be refused" >&2
  cat "$work/http.log" >&2
  exit 1
fi
[ -f "$calls_log" ] && {
  echo "FAIL: a rejected BASE_URL must never reach gcloud" >&2
  exit 1
}

# Every gcloud call must run with prompts disabled.
rm -f "$calls_log" "$capture" "$create_counter"
REQUIRE_PROMPTS_DISABLED=1 run_setup "https://parley.example.com" 1 >"$work/prompts.log" 2>&1 || {
  echo "FAIL: setup.sh must export CLOUDSDK_CORE_DISABLE_PROMPTS=1 before calling gcloud" >&2
  cat "$work/prompts.log" >&2
  exit 1
}

# First run: no existing deployment (describe fails), so setup.sh creates one.
rm -f "$calls_log" "$capture" "$create_counter"
run_setup "https://parley.example.com" 1 >"$work/first.log" 2>&1
grep -q "workspace-add-ons deployments create parley" "$calls_log" || {
  echo "FAIL: a first run should create the deployment" >&2
  cat "$calls_log" >&2
  exit 1
}
grep -q "workspace-add-ons deployments replace parley" "$calls_log" && {
  echo "FAIL: a first run should not call replace" >&2
  exit 1
}

# The manifest it built must carry BASE_URL into every placeholder.
grep -q '"name": "Parley"' "$capture"
grep -q '"sidePanelUrl": "https://parley.example.com/embed/meet/sidepanel"' "$capture"
grep -q '"addOnOrigins": \["https://parley.example.com"\]' "$capture"
grep -q '"logoUrl": "https://parley.example.com/favicon.svg"' "$capture"
grep -q "BASE_URL_PLACEHOLDER" "$capture" && {
  echo "FAIL: the manifest still has an unsubstituted placeholder" >&2
  cat "$capture" >&2
  exit 1
}

# The operator guide's example manifest is meant to be this exact template
# rendered with its own example BASE_URL — one source, not two hand-copied
# JSON blocks that can drift apart.
doc="$repo_root/site/src/content/docs/operations/google-meet.mdx"
awk '/^```json$/{p=1;next} /^```$/{if(p)exit} p' "$doc" >"$work/doc-manifest.json"
if ! diff -u "$work/doc-manifest.json" "$capture" >"$work/manifest-diff.log"; then
  echo "FAIL: the operator guide's example manifest no longer matches deploy/google-meet/manifest.template.json rendered with BASE_URL=https://parley.example.com" >&2
  cat "$work/manifest-diff.log" >&2
  exit 1
fi

# Re-run: the deployment already exists (describe succeeds), so setup.sh
# replaces it instead of failing on a duplicate create.
rm -f "$calls_log" "$create_counter"
run_setup "https://parley.example.com" 0 >"$work/second.log" 2>&1
grep -q "workspace-add-ons deployments replace parley" "$calls_log" || {
  echo "FAIL: a re-run should replace the existing deployment" >&2
  cat "$calls_log" >&2
  exit 1
}
grep -q "workspace-add-ons deployments create parley" "$calls_log" && {
  echo "FAIL: a re-run should not call create" >&2
  exit 1
}

# A just-enabled API rejects "create" twice with the activation error, then
# succeeds on the third try; setup.sh must retry and finish successfully.
rm -f "$calls_log" "$capture" "$create_counter"
CREATE_FAIL_COUNT=2 RETRY_MAX_ATTEMPTS=5 run_setup "https://parley.example.com" 1 >"$work/retry-ok.log" 2>&1 || {
  echo "FAIL: setup.sh should retry create through a transient activation error and succeed" >&2
  cat "$work/retry-ok.log" >&2
  exit 1
}
[ "$(grep -c "workspace-add-ons deployments create parley" "$calls_log")" -eq 3 ] || {
  echo "FAIL: expected exactly 3 create attempts (2 failures then a success)" >&2
  cat "$calls_log" >&2
  exit 1
}
grep -q "retrying" "$work/retry-ok.log" || {
  echo "FAIL: a retried run should say so" >&2
  cat "$work/retry-ok.log" >&2
  exit 1
}

# A create that never recovers must fail loudly, with gcloud's own error
# visible, once the retry budget is exhausted — not hang and not swallow it.
rm -f "$calls_log" "$capture" "$create_counter"
if CREATE_FAIL_COUNT=99 RETRY_MAX_ATTEMPTS=3 run_setup "https://parley.example.com" 1 >"$work/retry-fail.log" 2>&1; then
  echo "FAIL: setup.sh should exit nonzero once retries are exhausted" >&2
  cat "$work/retry-fail.log" >&2
  exit 1
fi
[ "$(grep -c "workspace-add-ons deployments create parley" "$calls_log")" -eq 3 ] || {
  echo "FAIL: expected exactly 3 create attempts before giving up" >&2
  cat "$calls_log" >&2
  exit 1
}
grep -q "has not been used in project" "$work/retry-fail.log" || {
  echo "FAIL: gcloud's own error must stay visible after retries are exhausted" >&2
  cat "$work/retry-fail.log" >&2
  exit 1
}

# A FAILED_PRECONDITION that has nothing to do with API activation (e.g. a
# billing problem) must not be mistaken for one and retried for two minutes —
# it should fail on the very first attempt.
rm -f "$calls_log" "$capture" "$create_counter"
if CREATE_FAIL_COUNT=99 RETRY_MAX_ATTEMPTS=5 \
  CREATE_ERROR_TEXT="ERROR: (gcloud.workspace-add-ons.deployments.create) FAILED_PRECONDITION: billing account not linked to this project." \
  run_setup "https://parley.example.com" 1 >"$work/nonactivation-fail.log" 2>&1; then
  echo "FAIL: setup.sh should exit nonzero on a non-activation FAILED_PRECONDITION" >&2
  cat "$work/nonactivation-fail.log" >&2
  exit 1
fi
[ "$(grep -c "workspace-add-ons deployments create parley" "$calls_log")" -eq 1 ] || {
  echo "FAIL: a non-activation FAILED_PRECONDITION must not be retried" >&2
  cat "$calls_log" >&2
  exit 1
}
grep -q "billing account not linked" "$work/nonactivation-fail.log" || {
  echo "FAIL: gcloud's own error must stay visible on the first attempt" >&2
  cat "$work/nonactivation-fail.log" >&2
  exit 1
}

# install-status reporting the add-on installed prints a checkmark.
rm -f "$calls_log" "$capture" "$create_counter"
INSTALL_STATUS_VALUE=True run_setup "https://parley.example.com" 1 >"$work/installed.log" 2>&1
grep -q "✅ installed" "$work/installed.log" || {
  echo "FAIL: a true install-status should print a checkmark" >&2
  cat "$work/installed.log" >&2
  exit 1
}

# install-status reporting it is not yet installed prints a cross, and an
# install-status call that fails outright also prints a cross rather than
# claiming success.
rm -f "$calls_log" "$capture" "$create_counter"
INSTALL_STATUS_VALUE=False run_setup "https://parley.example.com" 1 >"$work/notinstalled.log" 2>&1
grep -q "❌" "$work/notinstalled.log" || {
  echo "FAIL: a false install-status should print a cross" >&2
  cat "$work/notinstalled.log" >&2
  exit 1
}

rm -f "$calls_log" "$capture" "$create_counter"
INSTALL_STATUS_FAIL=1 run_setup "https://parley.example.com" 1 >"$work/statusfail.log" 2>&1
grep -q "❌" "$work/statusfail.log" || {
  echo "FAIL: a failed install-status call should print a cross, not a checkmark" >&2
  cat "$work/statusfail.log" >&2
  exit 1
}

# The final checklist names the four steps with no API: App configuration
# (with the required fields and the consent-screen banner note), the Store
# listing (with its required fields and that a Private app publishes
# immediately with no Google review), the admin's one-time toggle, and the
# self-install URL. The old "step 4 above" wording and the separate
# consent-screen step must be gone, and there must be no fifth step.
rm -f "$calls_log" "$capture" "$create_counter"
run_setup "https://parley.example.com" 1 >"$work/checklist.log" 2>&1
grep -q "App configuration" "$work/checklist.log"
grep -q "Developer Name" "$work/checklist.log"
grep -q "Developer Website" "$work/checklist.log"
grep -q "your BASE_URL, https://parley.example.com" "$work/checklist.log"
grep -q "Developer Email" "$work/checklist.log"
grep -q "OAuth Consent Screen must be enabled" "$work/checklist.log"
grep -q "Store listing" "$work/checklist.log"
grep -q "Application name" "$work/checklist.log"
grep -q "Terms of service" "$work/checklist.log"
grep -q "Privacy policy" "$work/checklist.log"
grep -qi "published immediately" "$work/checklist.log"
grep -qi "no Google review" "$work/checklist.log"
grep -q "Allow users to" "$work/checklist.log"
grep -q "install any internal app" "$work/checklist.log"
grep -q "workspace.google.com/marketplace/mydomainapps" "$work/checklist.log"
grep -q "^  5\." "$work/checklist.log" && {
  echo "FAIL: only four manual steps should remain" >&2
  cat "$work/checklist.log" >&2
  exit 1
}
grep -q "step 4 above" "$work/checklist.log" && {
  echo "FAIL: the stale 'step 4 above' wording must be gone" >&2
  cat "$work/checklist.log" >&2
  exit 1
}
grep -qE "^  2\. The OAuth consent screen" "$work/checklist.log" && {
  echo "FAIL: the consent screen must no longer be its own manual step" >&2
  cat "$work/checklist.log" >&2
  exit 1
}

echo "meet-setup-test.sh: ok"
