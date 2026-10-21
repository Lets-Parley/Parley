# Joins the ui/ modules into the body of one function (see UI_SRC in the
# Makefile). A file's leading import statements, and the blank line after
# them, are dropped; `export ` is dropped from the start of a line; every other
# line is indented two spaces, as the body of the function it is put in.
#
# It understands exactly two import forms, named imports with no renaming from
# a relative double-quoted path, on one line or as an `import {` line, name
# lines and a closing `} from "...";` line:
#
#   import { a, b } from "./x.js";
#   import {
#     a, b,
#   } from "../x.js";
#
# and exports only as a keyword in front of a declaration at the start of a
# line. Anything else (a default export, `export { … }`, `export *`, a
# side-effect import, a renamed import, single quotes, an import after the
# first statement) stops the build rather than being joined wrong.
function fail(why) {
  print FILENAME ":" FNR ": " why ": " $0 > "/dev/stderr"
  failed = 1
  exit 1
}
FNR == 1 { head = 1; importing = 0; afterImports = 0 }
importing {
  if ($0 ~ /^\} from "\.\.?\/[^"]+\.js";$/) { importing = 0; afterImports = 1; next }
  if ($0 ~ /^  [A-Za-z_$][A-Za-z0-9_$]*(, [A-Za-z_$][A-Za-z0-9_$]*)*,$/) next
  fail("not a name line of a named import")
}
head && /^import/ {
  if ($0 ~ /^import \{ [A-Za-z_$][A-Za-z0-9_$]*(, [A-Za-z_$][A-Za-z0-9_$]*)* \} from "\.\.?\/[^"]+\.js";$/) { afterImports = 1; next }
  if ($0 == "import {") { importing = 1; next }
  fail("an import form the join does not handle")
}
afterImports && $0 == "" { afterImports = 0; head = 0; next }
{
  head = 0
  afterImports = 0
  if ($0 ~ /^import[ {"'*]/) fail("an import after the file's first statement")
  if ($0 ~ /^export/) {
    if ($0 !~ /^export (async function|function|const|let|class) /) fail("an export form the join does not handle")
    sub(/^export /, "")
  }
  if ($0 != "") $0 = "  " $0
  print
}
END { if (importing && !failed) { print FILENAME ": an import that never ends" > "/dev/stderr"; exit 1 } }
