# Plugin SDK

Packages for writing a Parley plugin without touching the host.

| Package | npm name |
| --- | --- |
| `plugin-sdk/` | `@parley/plugin-sdk` |
| `plugin-ui/` | `@parley/plugin-ui` |
| `abi/v1.json` | the frozen wire protocol |

```sh
node sdk/plugin-sdk/src/cli.js scaffold ./my-plugin
node sdk/plugin-sdk/src/cli.js build ./my-plugin
node sdk/plugin-sdk/src/cli.js verify ./my-plugin
```

`dev` talks to `POST /api/orgs/{org}/admin/plugins/dev-register`, which exists
only in a binary built with `-tags plugindev`.
