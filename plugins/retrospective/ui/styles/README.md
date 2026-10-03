# styles/

The stylesheet, as arrays of CSS strings: `tokens.js` holds the fallback
palettes, each other file the rules for one part of the page, and `sheet.js`
joins the parts into `STYLES` and adds the embedded font faces. The order of
the parts in `sheet.js` is the cascade order.
