#!/bin/sh
# Exercises deploy/google-meet/setup.sh against a stub gcloud on PATH, since
# a real run needs a live Cloud project. Covers the acceptance criteria from
# issue #643: BASE_URL is validated before any gcloud call, a first run
# creates the deployment, a re-run replaces it, and the manifest it builds
# matches BASE_URL.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
setup="$repo_root/deploy/google-meet/setup.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

stub_bin="$work/bin"
mkdir -p "$stub_bin"
calls_log="$work/calls.log"
capture="$work/deployment-file-content.json"

# describe_exit controls whether the stub's "describe" subcommand reports the
# deployment as already existing (0) or not (1), which is what setup.sh
# branches create vs. replace on.
cat > "$stub_bin/gcloud" <<'STUB'
#!/bin/sh
set -eu
echo "$@" >>"$CALLS_LOG"
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
      create|replace)
        for arg in "$@"; do
          case "$arg" in
            --deployment-file=*)
              cp "${arg#--deployment-file=}" "$CAPTURE"
              ;;
          esac
        done
        ;;
      install) ;;
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

# First run: no existing deployment (describe fails), so setup.sh creates one.
rm -f "$calls_log" "$capture"
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
rm -f "$calls_log"
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

echo "meet-setup-test.sh: ok"
