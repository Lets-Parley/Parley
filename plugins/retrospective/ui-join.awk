# Joins the ui/ modules into the body of one function (see UI_SRC in the
# Makefile). A file's leading import statements, and the blank line after
# them, are dropped; `export ` is dropped from the start of a line; every other
# line is indented two spaces, as the body of the function it is put in.
FNR == 1 { head = 1; importing = 0; afterImports = 0 }
head && /^import / { importing = 1 }
importing {
  if ($0 ~ / from "[^"]+";$/) { importing = 0; afterImports = 1 }
  next
}
afterImports && $0 == "" { afterImports = 0; head = 0; next }
{
  head = 0
  afterImports = 0
  if ($0 ~ /^import /) { print FILENAME ":" FNR ": an import after the file's first statement" > "/dev/stderr"; exit 1 }
  sub(/^export /, "")
  if ($0 != "") $0 = "  " $0
  print
}
