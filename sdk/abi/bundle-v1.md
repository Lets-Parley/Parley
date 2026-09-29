# Plugin bundle format, version 1 (`.parley`)

A `.parley` file is a gzip-compressed USTAR tar archive. The reference
implementation is `internal/plugin/bundle` (`Pack`, `Verify`); the golden
vectors in `bundle-v1/` are normative, and any packer must reproduce
`bundle-v1/expected.parley` byte for byte from `bundle-v1/input/` and
`bundle-v1/TEST-ONLY-signing.key`.

## Files

| Name | Required | Contents |
| --- | --- | --- |
| `manifest.json` | yes | the plugin manifest; a legacy `package.json` is accepted in its place by a verifier, never both |
| `plugin.wasm` | yes | the module, at most 10 MiB |
| `ui.js` | no | the plugin UI script |
| `slots.json` | no | UI slot declarations |
| `MANIFEST.sha256` | yes | digests of every file above that is present |
| `MANIFEST.sig` | when signed | the signature |

No other name is allowed. Names are bare: no `/`, no `\`, not `.` or `..`.

## MANIFEST.sha256

One line per file above that the bundle carries, sorted by name (bytewise),
each `<lowercase hex sha256>  <name>\n` (two spaces, trailing newline on every
line). It never lists itself or `MANIFEST.sig`.

The bundle **digest**, its identity, is the lowercase hex sha256 of the
`MANIFEST.sha256` bytes.

## Signature

`MANIFEST.sig` is 96 bytes: the 32-byte Ed25519 public key followed by the
64-byte pure Ed25519 signature (RFC 8032, no prehash, no context) over

    "parley-bundle-v1\n" || MANIFEST.sha256

The **key id** is the first 8 bytes of sha256(public key), lowercase hex. The
verifier computes it; nothing in the manifest (a `publisher` field or
otherwise) is trusted to identify the signer. A private key file, as written by
`parley plugin keygen`, is the base64 of the 32-byte Ed25519 seed; the `.pub`
file is the base64 of the public key.

## Archive encoding (deterministic)

- Entries in bytewise name order, all of them including `MANIFEST.*`.
- Each header: USTAR format, typeflag `0`, mode 0, uid/gid 0, empty
  uname/gname, mtime 0, empty linkname; numeric fields zero-padded octal
  NUL-terminated, as Go's `archive/tar` writes them. Content padded to 512.
- Two 512-byte zero blocks end the archive, with no further record padding.
- gzip: header `1f 8b 08 00 00000000 00 ff` (no name, mtime 0, XFL 0,
  OS 255). The deflate stream uses stored blocks only: non-final blocks of up
  to 65535 bytes, then an empty stored block with BFINAL set. Then CRC-32 and
  ISIZE.

## Verification refusals

A verifier refuses, before returning any content: an entry not listed in
`MANIFEST.sha256`; a listed file that is missing; a digest mismatch; a name
with path components; a symlink or other non-regular entry; a duplicate; a
name the format does not define; `plugin.wasm` over 10 MiB; a decompressed
tar stream over 16 MiB (counted while streaming); a signature that does not
verify; a key the instance does not trust; and an unsigned bundle unless the
operator allowed unsigned bundles.
