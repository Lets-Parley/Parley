#!/usr/bin/env bash
# Single source of truth for every place outside site/src/version.mjs that
# names the current Parley release. scripts/bump-release-pins.sh writes these
# locations; scripts/check-release-pins.sh reads them back. Add a pinned
# location here once and both scripts see it — that is the whole point of the
# indirection: a script that hardcoded its own copy of this list could drift
# from the other one's copy exactly the way the files themselves drifted.
#
# Each entry is a (file, template) pair. The template is the exact literal
# text surrounding the version number, with the version itself replaced by the
# token "@V@". A template must appear in its file exactly as written, with
# only the version differing — a checker or a bump that instead matched "any
# X.Y.Z near this word" would silently walk past a line the last bump reworded.
#
# This file only declares the list; it does no I/O and takes no dependency
# beyond bash, so sourcing it is safe from either script or their tests.

set -euo pipefail

# The version.mjs line is the source of truth, not a pin: bump-release-pins.sh
# writes it first and separately, then treats its new value as the target for
# every pin below. Both are read by every script that sources this file, not
# by this one.
# shellcheck disable=SC2034
VERSION_FILE="site/src/version.mjs"
# shellcheck disable=SC2034
VERSION_TEMPLATE='export const VERSION = "@V@";'

RELEASE_PIN_FILES=()
RELEASE_PIN_TEMPLATES=()

add_release_pin() {
  RELEASE_PIN_FILES+=("$1")
  RELEASE_PIN_TEMPLATES+=("$2")
}

add_release_pin "README.md" "ghcr.io/lets-parley/parley:@V@"
add_release_pin "README.md" "— @V@ is the current release."
add_release_pin "README.md" "helm install parley oci://ghcr.io/lets-parley/charts/parley --version @V@ \\"
add_release_pin "README.md" "helm upgrade parley oci://ghcr.io/lets-parley/charts/parley --version @V@ \\"
# shellcheck disable=SC2016
add_release_pin "README.md" '`--version @V@` when you scale up.'
add_release_pin "SECURITY.md" "| @V@ | Yes |"
add_release_pin "SECURITY.md" "current release, v@V@."
add_release_pin "SECURITY.md" '{"version":"@V@"}'
add_release_pin "deploy/charts/parley/Chart.yaml" "--set image.tag=@V@."
add_release_pin "deploy/charts/parley/templates/_helpers.tpl" '--set image.tag=@V@" -}}'
# shellcheck disable=SC2016
add_release_pin "deploy/charts/parley/values.yaml" '(`@V@-fips`);'
add_release_pin "deploy/k8s/deployment.yaml" "image: ghcr.io/lets-parley/parley:@V@"
add_release_pin "docker-compose.yml" "image: ghcr.io/lets-parley/parley:@V@"
# shellcheck disable=SC2016
add_release_pin "site/src/content/docs/operations/deployment.mdx" '(`@V@-fips`, and'

read_version() {
  local file=$1
  sed -n 's/^export const VERSION = "\([0-9][0-9.]*\)".*/\1/p' "$file"
}

# Escapes every character extended regular expressions treat specially, so a
# template's literal text (parentheses, brackets, the version dots, the helm
# line's trailing backslash) can be dropped straight into a sed -E pattern
# instead of being re-typed as a regex by hand.
ere_escape() {
  local s=$1
  # $cb ('}') and its replacement can't be written as literal characters
  # inside ${s//pattern/replacement}: an unescaped '}' there closes the
  # expansion early, so it has to come in through a variable instead.
  local cb='}'
  s=${s//\\/\\\\}
  s=${s//./\\.}
  s=${s//\*/\\*}
  s=${s//+/\\+}
  s=${s//\?/\\?}
  s=${s//\(/\\(}
  s=${s//\)/\\)}
  s=${s//\[/\\[}
  s=${s//\]/\\]}
  s=${s//\{/\\{}
  s=${s//$cb/\\$cb}
  s=${s//^/\\^}
  s=${s//\$/\\$}
  s=${s//|/\\|}
  printf '%s' "$s"
}

# Builds the sed -E pattern for a template, with the version captured as its
# own group so it can be read back (current_pin_version) or replaced in place
# without disturbing the literal text around it.
pin_pattern() {
  local template=$1
  local left=${template%%@V@*}
  local right=${template#*@V@}
  printf '(%s)([0-9]+\.[0-9]+\.[0-9]+)(%s)' "$(ere_escape "$left")" "$(ere_escape "$right")"
}

# The version currently at a pin's anchor in a file, or empty if the anchor
# (the literal text around @V@) is not in the file at all.
#
# \x01 is the sed delimiter, not '/': several templates contain a literal
# '/' (every ghcr.io and oci:// pin), which would otherwise end the pattern
# early.
current_pin_version() {
  local file=$1 template=$2
  sed -n -E $'s\x01.*'"$(pin_pattern "$template")"$'.*\x01\\2\x01p' "$file" | head -n 1
}
