# HentaiNexus for Paperback

A [Paperback](https://paperback.moe) 0.9 extension for `hentainexus.com`.

**18+.** This source is rated `ADULT`, so Paperback only surfaces it when adult
content is enabled in your app profile.

## Installing

Paperback installs extensions from a repository URL, not from a file. Add this
URL in **Paperback → Settings → Extensions → Add Repository**:

```
https://shmowzy27.github.io/paperback-extension/
```

Then install **HentaiNexus** from the list.

## Features

| | |
|---|---|
| Discover | New Releases (paginated) and Popular |
| Search | Full text, plus the site's own filter syntax |
| Details | Artist, parody, publisher, page count, tags, description |
| Reading | Full page list with AVIF or JPEG/PNG output |
| Settings | Image format, shortened titles |
| Cloudflare | Surfaces Paperback's bypass banner when challenged |

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
decodes in [`decoder.ts`](src/HentaiNexus/decoder.ts):

1. The payload is base64, and its first 64 bytes are a key whose leading bytes
   are XORed with the **hostname the page was served from** — this binds the
   payload to the domain.
2. A CRC over that key selects a stride from the first 16 primes.
3. An RC4 variant using that stride decrypts the remainder into JSON.

Because step 1 is domain-bound, `HOSTNAME` in
[`models.ts`](src/HentaiNexus/models.ts) must be updated if the site ever moves
domains, or the manifest will decode to garbage.

## Development

```bash
npm install
npm run tsc      # typecheck
npm run bundle   # emit ./bundles
npm run dev      # serve with live reload for on-device testing
```

Pushing to `main` bundles and publishes to GitHub Pages automatically.

## Notes

This extension is not affiliated with the site or with Paperback, and it hosts
no content — it only reads pages that are already publicly served. Inkdex and
the official Paperback repositories do not carry adult sources, which is why
this is a standalone repository.
