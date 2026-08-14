# HentaiNexus for Paperback

A [Paperback](https://paperback.moe) **0.8** extension for `hentainexus.com`.

**18+.** This source is rated `ADULT`, so Paperback only surfaces it when adult
content is enabled in your app profile.

## Installing

Paperback installs extensions from a repository URL, not from a file. Add this
URL in **Paperback → Settings → Extensions → Add Repository**:

```
https://shmowzy27.github.io/paperback-extension/
```

Then install **HentaiNexus** from the list.

> The repository is named `paperback-extension` because GitHub's automated
> naming rules renamed it on creation. The URL above is the one that works.

## Versions

| Branch | Paperback | SDK |
|---|---|---|
| `main` | 0.8 (App Store) | `@paperback/types@0.8.7` |
| `0.9` | 0.9 (beta) | `@paperback/types@1.0.0-alpha.92` |

`main` is what the published URL serves. The `0.9` branch holds a complete port
against the newer SDK, kept for whenever 0.9 ships — the two SDKs are not
compatible, and 0.9 replaced the `author` field with `developers`.

## Features

| | |
|---|---|
| Home | New Releases (paginated) and Popular |
| Search | Full text, plus the site's own filter syntax |
| Details | Artist, parody, publisher, page count, tags, description |
| Reading | Full page list |
| Cloudflare | Surfaces Paperback's bypass prompt when challenged |

### Search syntax

Plain text searches titles. The site's own filter syntax is passed straight
through, so these all work:

```
artist:Homunculus
tag:glasses
parody:"Original Work"
publisher:FAKKU
```

## How the reader works

Galleries do not expose a page list as JSON. `/read/{id}` ships a single
`initReader("…")` call holding an encrypted manifest, which this extension
decodes in [`HentaiNexusDecoder.ts`](src/HentaiNexus/HentaiNexusDecoder.ts):

1. The payload is base64, and its first 64 bytes are a key whose leading bytes
   are XORed with the **hostname the page was served from** — this binds the
   payload to the domain.
2. A CRC over that key selects a stride from the first 16 primes.
3. An RC4 variant using that stride decrypts the remainder into JSON.

Because step 1 is domain-bound, `HN_HOSTNAME` must be updated if the site ever
moves domains, or the manifest will decode to garbage.

## Development

```bash
npm install
npx tsc          # typecheck
npm run bundle   # emit ./bundles
npm run serve    # serve locally for on-device testing
```

Pushing to `main` bundles and publishes to GitHub Pages automatically.

## Notes

This extension is not affiliated with the site or with Paperback, and it hosts
no content — it only reads pages that are already publicly served. Inkdex and
the official Paperback repositories do not carry adult sources, which is why
this is a standalone repository.
