// apps/extension/src/lib/artifacts/manifest-meta-regex.ts
//
// Shared matcher for the `<meta name="openbrowse:artifact" ...>` tag that
// carries the inlined manifest. Used by both the registry (strip + extract on
// save/load) and build-iframe-doc (strip before the runtime iframe).
//
// Design notes:
//   - The attribute char class excludes `>` AND both quote chars. Excluding the
//     quotes forces the engine through the quoted-run branch whenever it hits a
//     quote, so an unrelated tag whose quoted value happens to contain
//     `name='openbrowse:artifact'` can't be mistaken for the manifest tag, and
//     a `>` inside a quoted value (the inlined JSON can contain one) doesn't
//     terminate the match early.
//   - The leading `${ATTR}*?` accepts any attributes BEFORE `name`, so order
//     doesn't matter (e.g. `<meta http-equiv="x" name="openbrowse:artifact">`).
//   - `\s*=\s*` tolerates the standard HTML whitespace around the equals sign.

const ATTR = `(?:"[^"]*"|'[^']*'|[^>"'])`;

/**
 * Fresh, global, case-insensitive regex matching one manifest meta tag.
 * Returns a NEW RegExp each call so callers never share `lastIndex` state
 * (relevant for `.exec`/`.test`; harmless but explicit for `.match`/`.replace`).
 */
export function manifestMetaTagRegex(): RegExp {
  return new RegExp(
    `<meta\\b${ATTR}*?\\bname\\s*=\\s*(?:"openbrowse:artifact"|'openbrowse:artifact')${ATTR}*>`,
    "gi",
  );
}
