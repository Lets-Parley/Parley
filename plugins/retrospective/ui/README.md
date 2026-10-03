# ui/

The retrospective board, as ES modules. `main.js` builds the page once and
boots it; everything else is imported from the folders beside it. The build
joins these files into one scope in the order `UI_SRC` in `../Makefile` lists,
so a new file goes into that list after everything its top-level code uses.
See `../README.md` for how the board talks to the host.
