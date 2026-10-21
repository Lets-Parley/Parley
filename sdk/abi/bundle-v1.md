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

No other name is allowed. Names are bare: not empty, no `/`, no `\`, not `.`
or `..`.

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
`parley plugin keygen`, is the standard (padded) base64 of the 32-byte
Ed25519 seed followed by one `\n`; the `.pub` file is the base64 of the
32-byte public key followed by one `\n`. Readers should trim surrounding
whitespace.

## Archive encoding (deterministic)

The tar stream is the entries in bytewise name order, all of them including
`MANIFEST.*`. Each entry is one 512-byte header, then the content, then zero
bytes up to the next multiple of 512 (none when the size already is one). Two
512-byte zero blocks end the stream, with no further record padding. There
are no PAX, GNU or other extended headers. Names are at most 100 bytes (every
name the format defines is far shorter).

### Header (512 bytes)

"NUL-filled" means every byte of the field is `0x00`. Octal numbers are ASCII
digits `0`-`7`, zero-padded on the left.

| Offset | Length | Field | Bytes |
| --- | --- | --- | --- |
| 0 | 100 | name | the name, then NUL-filled |
| 100 | 8 | mode | `0000000` + NUL |
| 108 | 8 | uid | `0000000` + NUL |
| 116 | 8 | gid | `0000000` + NUL |
| 124 | 12 | size | content length as 11 octal digits + NUL |
| 136 | 12 | mtime | `00000000000` + NUL |
| 148 | 8 | chksum | see below |
| 156 | 1 | typeflag | `0` |
| 157 | 100 | linkname | NUL-filled |
| 257 | 6 | magic | `ustar` + NUL |
| 263 | 2 | version | `00` |
| 265 | 32 | uname | NUL-filled |
| 297 | 32 | gname | NUL-filled |
| 329 | 8 | devmajor | `0000000` + NUL |
| 337 | 8 | devminor | `0000000` + NUL |
| 345 | 155 | prefix | NUL-filled |
| 500 | 12 | padding | NUL-filled |

The checksum is the unsigned sum of all 512 header bytes computed with the
chksum field taken as eight spaces (`0x20`), written as 6 octal digits, a NUL
and a space. For example the first header of the golden vector has
chksum `011332` + NUL + space.

### gzip

One gzip member and nothing after it:

- Header, 10 bytes: `1f 8b 08 00 00 00 00 00 00 ff` (deflate, no flags,
  mtime 0, XFL 0, OS 255).
- Deflate body, stored blocks only. The tar stream is cut into consecutive
  65535-byte blocks; the remainder (if any) is one more block; each of these
  is written as a non-final stored block: header byte `00`, then LEN as 2 bytes
  little-endian, then NLEN (the ones' complement of LEN) as 2 bytes
  little-endian, then the LEN bytes. Then one empty final block:
  `01 00 00 ff ff`.
- Trailer, 8 bytes: CRC-32 of the tar stream, then its length mod 2^32, both
  little-endian.

The `large/` vector (a wasm over 128 KiB) exercises the block split: two full
65535-byte blocks, a 13826-byte remainder block, then the empty final block.

## Verification refusals

A verifier refuses, before returning any content: an entry not listed in
`MANIFEST.sha256`; a listed file that is missing; a digest mismatch; a name
with path components; a symlink or other non-regular entry; a duplicate; a
name the format does not define; an empty name; `plugin.wasm` over 10 MiB; a decompressed
tar stream over 16 MiB, headers, padding and end blocks included (counted
while streaming), or declared entry sizes summing past 16 MiB; any bytes after
the first gzip member, including a second member; a `MANIFEST.sha256` that
is not exactly the canonical rendering above; a signature that does not
verify; a key the instance does not trust; and an unsigned bundle unless the
operator allowed unsigned bundles.
