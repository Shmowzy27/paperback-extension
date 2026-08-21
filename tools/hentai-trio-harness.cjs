/*
 * Runs the built NHentai, HentaiHere and Hentai2Read bundles against the live
 * sites.
 *
 * Beyond listings/details/chapters/pages,every source is audited against the
 * standing exclusions (BL/yaoi/males-only, ugly bastard, bald) with real data:
 * known excluded titles must refuse to open, and sampled listing titles must
 * come back clean.
 *
 * The stub follows redirects by hand with a cookie jar, because hentaihere's
 * saved-filter flow sets its cookie on a 302 and Node's fetch drops cookies
 * across hops -- the app's native client carries them, so the stub must too.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'

const identity = (x) => x

const makeApp = (gapMs) => {
    const jar = new Map()
    const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    const store = (res) => {
        for (const line of res.headers.getSetCookie?.() ?? []) {
            const pair = line.split(';')[0]
            const eq = pair.indexOf('=')
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
        }
    }
    let last = 0
    return {
        createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
        createMangaInfo: identity, createTag: identity, createTagSection: identity,
        createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
        createHomeSection: (i) => ({ ...i }),
        createRequestManager: (opts) => ({
            getDefaultUserAgent: async () => UA,
            cookieStore: { getAllCookies: () => [] },
            schedule: async (request, retry) => {
                let lastError
                for (let attempt = 0; attempt <= (retry ?? 1); attempt++) {
                    const wait = Math.max(0, last + gapMs - Date.now())
                    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
                    last = Date.now()
                    try {
                        const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
                        let url = req.url
                        let method = req.method || 'GET'
                        let body = req.data
                        let res
                        for (let hop = 0; hop < 4; hop++) {
                            res = await fetch(url, {
                                method: method,
                                headers: { 'accept-language': 'en-US,en;q=0.9', ...(req.headers || {}), cookie: cookieHeader() },
                                body: method === 'POST' ? body : undefined,
                                redirect: 'manual',
                                signal: AbortSignal.timeout(opts.requestTimeout || 30000)
                            })
                            store(res)
                            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                                url = new URL(res.headers.get('location'), url).href
                                method = 'GET'
                                body = undefined
                                continue
                            }
                            break
                        }
                        const text = await res.text()
                        if (res.ok && text.length === 0) throw new Error('empty response body')
                        return { data: text, status: res.status, headers: {}, request: req }
                    } catch (error) { lastError = error }
                }
                throw lastError
            }
        })
    }
}

const path = require('node:path')
let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}
const note = (label, detail) => console.log(`note  ${label}${detail ? ` — ${detail}` : ''}`)

const load = (dir, cls, gapMs) => {
    global.App = makeApp(gapMs)
    const key = require.resolve(path.join(__dirname, '..', 'bundles', dir, 'source.js'))
    delete require.cache[key]
    return new (require(key).Sources[cls])()
}

// The image CDNs rotate hosts and occasionally refuse a bare probe, so an
// unreachable host is reported rather than crashing the run -- the same
// treatment the other harnesses give it.
const probeImage = async (url, referer) => {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: referer } })
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, 12)
    const looksImage = (head[0] === 0xFF && head[1] === 0xD8)
        || head.toString('ascii', 1, 4) === 'PNG'
        || head.toString('ascii', 8, 12) === 'WEBP'
        || head.toString('ascii', 4, 8) === 'ftyp'
        || (head[0] === 0x47 && head[1] === 0x49)
    return { ok: res.ok && looksImage, status: res.status, type: res.headers.get('content-type') }
  } catch (error) {
    return { unreachable: true, status: '-', type: error.message.slice(0, 40) }
  }
}

const expectGateThrow = async (label, fn) => {
    try {
        await fn()
        check(label, false, 'opened instead of refusing')
    } catch (error) {
        check(label, /excluded by your settings/i.test(error.message), error.message.slice(0, 90))
    }
}

;(async () => {
    // ================= nhentai =================
    console.log('===== nhentai (Filtered) =====')
    {
        const s = load('NHentai', 'NHentai', 4500)

        const sections = []
        await s.getHomePageSections((sec) => sections.push(sec))
        check('home sections all carry items',
            sections.length === 3 && sections.every((x) => Array.isArray(x.items) && x.items.length > 0),
            sections.map((x) => `${x.title}:${x.items?.length}`).join(', '))

        const more = await s.getViewMoreItems('new', { page: 2, seen: sections[0].items.map((t) => t.mangaId) })
        const all = sections[0].items.map((t) => t.mangaId).concat(more.results.map((t) => t.mangaId))
        check('listing paginates without duplicate ids',
            more.results.length > 0 && new Set(all).size === all.length,
            `${all.length} items, ${new Set(all).size} unique`)

        const id = sections[0].items[0].mangaId
        const d = await s.getMangaDetails(id)
        const tagLabels = d.mangaInfo.tags.flatMap((sec) => sec.tags.map((t) => t.label))
        check('details parse', d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('https://') && tagLabels.length > 0,
            `"${d.mangaInfo.titles[0]?.slice(0, 50)}" tags=${tagLabels.length}`)
        check('sampled title carries no banned tag',
            !tagLabels.some((label) => /^(yaoi|males only|ugly bastard|bald|tomgirl|crossdressing)$/i.test(label)),
            tagLabels.filter((l) => /yaoi|males only|ugly bastard|bald|tomgirl|crossdress/i.test(l)).join(',') || 'clean')

        // Written before volumes were merged, this used to demand exactly one
        // chapter; a listing entry is now a series and may legitimately carry
        // several. What must hold is that the volumes are distinct, ordered,
        // and that the one whose record was fetched for the details carries a
        // real date.
        const chapters = await s.getChapters(id)
        check('entry lists its volumes as ordered, distinct chapters',
            chapters.length >= 1
                && new Set(chapters.map((c) => c.id)).size === chapters.length
                && chapters.every((c, i) => i === 0 || chapters[i - 1].chapNum <= c.chapNum),
            `${chapters.length} chapter(s): ${chapters.map((c) => c.chapNum).join(',')}`)
        // A gallery opened straight from a listing is served from the
        // remembered listing entry, which carries no upload date -- that is
        // the trade that makes opening it instant. Dates come from the gallery
        // record, so they are asserted on the merged-series path below, which
        // fetches one.
        note('dates on a listing-served entry',
            chapters.filter((c) => c.time instanceof Date).length + ' of ' + chapters.length + ' dated')

        const pages = await s.getChapterDetails(id, 'gallery')
        check('pages resolve', pages.pages.length > 1 && pages.pages.every((p) => p.startsWith('https://')),
            `${pages.pages.length} pages from ${new URL(pages.pages[0]).host}`)
        const img = await probeImage(pages.pages[0], 'https://nhentai.net/')
        if (img.unreachable) note('image CDN unreachable from here', `${new URL(pages.pages[0]).host}: ${img.type}`)
        else check('first page fetches real image bytes', img.ok, `${img.status} ${img.type}`)

        // Gallery 674659 is tagged yaoi + males only on the live site; it was
        // the gallery the banned ids were verified against.
        // ---- volume merging (HentaiNexus-style) ----
        // The site publishes a multi-volume work as separate galleries, so the
        // source merges them. WASANBON NAGI is a real series spanning volumes
        // 1-3 on the live site.
        const merged = await s.getMangaDetails('s:WASANBON NAGI')
        check('a merged series opens under its series name',
            merged.mangaInfo.titles[0] === 'WASANBON NAGI',
            `"${merged.mangaInfo.titles[0]}"`)

        const vols = await s.getChapters('s:WASANBON NAGI')
        // Not every volume the site lists survives: the standing exclusions are
        // applied to the sibling search too, and `bald` alone covers some
        // twelve thousand galleries. So this asserts that volumes genuinely
        // merge, not that a particular count comes back.
        check('several volumes merge into one entry',
            vols.length >= 2 && new Set(vols.map((c) => c.id)).size === vols.length,
            `${vols.length} chapters: ${vols.map((c) => c.chapNum).join(',')}`)
        check('volumes are in ascending order',
            vols.every((c, i) => i === 0 || vols[i - 1].chapNum <= c.chapNum),
            vols.map((c) => c.chapNum).join(','))
        check('merged chapters carry real dates',
            vols.some((c) => c.time instanceof Date && !isNaN(c.time.getTime())),
            vols.filter((c) => c.time instanceof Date).length + ' of ' + vols.length + ' dated')
        check('chapter ids are gallery ids',
            vols.every((c) => /^\d+$/.test(c.id)), vols.map((c) => c.id).join(',').slice(0, 60))

        const volPages = await s.getChapterDetails('s:WASANBON NAGI', vols[vols.length - 1].id)
        check('a specific volume resolves its own pages',
            volPages.pages.length > 0 && volPages.pages.every((p) => p.startsWith('https://')),
            `${volPages.pages.length} pages`)

        // Tiles are a deliberate mix. A numbered gallery becomes an `s:` series
        // so its volumes merge; an unnumbered one keeps its own gallery id,
        // which is what lets it open on a single request against an API that
        // allows only about ten a minute. Both forms must be well-formed, and
        // merging must still be happening.
        const ids = sections[0].items.map((t) => t.mangaId)
        const seriesTiles = ids.filter((id) => id.startsWith('s:'))
        check('tiles are either a merged series or a plain gallery id',
            ids.length > 0 && ids.every((id) => id.startsWith('s:') || /^\d+$/.test(id)),
            `${seriesTiles.length} merged of ${ids.length}`)
        check('numbered galleries are still being merged',
            seriesTiles.length > 0, seriesTiles.slice(0, 2).join(' | ') || 'none merged')

        await expectGateThrow('a yaoi gallery refuses to open', () => s.getMangaDetails('674659'))

        const search = await s.getSearchResults({ title: 'milf', includedTags: [], excludedTags: [], parameters: {} }, undefined)
        check('search returns results', search.results.length > 0, `${search.results.length} results`)

        // The filter screen offers language, browsable catalogs read off the
        // site, and the standing exclusions shown for visibility. The banned
        // names sit inside the popular tag list, so the scrub is asserted on
        // the catalogs rather than assumed.
        const tags = await s.getSearchTags()
        const catalogs = tags.filter((sec) => ['tag', 'artist', 'parody'].includes(sec.id))
        const offered = catalogs.flatMap((sec) => sec.tags.map((t) => t.label.toLowerCase()))
        check('language, tag catalogs and exclusions all offered',
            tags[0]?.tags.length === 3
                && catalogs.length === 3
                && catalogs.every((sec) => sec.tags.length > 50)
                && tags[tags.length - 1]?.id === 'excluded',
            tags.map((sec) => `${sec.id}:${sec.tags.length}`).join(' '))
        check('banned tags are scrubbed from the offered catalogs',
            !offered.some((label) => ['yaoi', 'males only', 'ugly bastard', 'bald', 'tomgirl', 'crossdressing'].includes(label)),
            `${offered.length} tags offered, none banned`)

        const browsable = catalogs[0]?.tags[0]
        const byTag = await s.getSearchResults({ title: '', includedTags: [browsable], excludedTags: [], parameters: {} }, undefined)
        check('selecting a catalog tag browses it', byTag.results.length > 0,
            `${browsable?.id} -> ${byTag.results.length} results`)
    }

    // ================= hentaihere =================
    console.log('\n===== HentaiHere (Filtered) =====')
    {
        const s = load('HentaiHere', 'HentaiHere', 1200)

        const sections = []
        await s.getHomePageSections((sec) => sections.push(sec))
        check('home sections all carry items',
            sections.length === 3 && sections.every((x) => Array.isArray(x.items) && x.items.length > 0),
            sections.map((x) => `${x.title}:${x.items?.length}`).join(', '))

        let meta = undefined
        const ids = []
        for (let i = 0; i < 2; i++) {
            const res = await s.getViewMoreItems('newest', meta)
            for (const t of res.results) ids.push(t.mangaId)
            meta = res.metadata
            if (!meta) break
        }
        check('saved-filter listing paginates without duplicates',
            ids.length > 40 && new Set(ids).size === ids.length,
            `${ids.length} items, ${new Set(ids).size} unique`)

        const id = ids[0]
        const d = await s.getMangaDetails(id)
        check('details parse', d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('http'),
            `"${d.mangaInfo.titles[0]?.slice(0, 50)}" tags=${d.mangaInfo.tags[0]?.tags?.length ?? 0}`)

        const chapters = await s.getChapters(id)
        check('chapters parse', chapters.length > 0, `${chapters.length} chapters`)

        const pages = await s.getChapterDetails(id, chapters[0].id)
        check('pages resolve', pages.pages.length > 0 && pages.pages.every((p) => p.startsWith('https://')),
            `${pages.pages.length} pages from ${new URL(pages.pages[0]).host}`)
        const img = await probeImage(pages.pages[0], 'https://hentaihere.com/')
        if (img.unreachable) note('image CDN unreachable from here', `${new URL(pages.pages[0]).host}: ${img.type}`)
        else check('first page fetches real image bytes', img.ok, `${img.status} ${img.type}`)

        // Ground truth from the site's own yaoi category listing.
        const yaoiHtml = await (await fetch('https://hentaihere.com/search/T27', { headers: { 'user-agent': UA } })).text()
        const yaoiId = /\/m\/(S\d+)/.exec(yaoiHtml)?.[1]
        if (yaoiId) {
            await expectGateThrow(`a yaoi title refuses to open (${yaoiId})`, () => s.getMangaDetails(yaoiId))
        } else {
            note('could not sample a yaoi id for the gate test')
        }

        const search = await s.getSearchResults({ title: 'sister', includedTags: [], excludedTags: [], parameters: {} }, undefined)
        check('search returns results', search.results.length > 0, `${search.results.length} results`)

        const tags = await s.getSearchTags()
        const offered = tags.flatMap((sec) => sec.tags.map((t) => t.label))
        check('tag catalog offered with banned entries scrubbed',
            offered.length > 30 && !offered.some((label) => /yaoi/i.test(label)),
            `${offered.length} tags, yaoi absent`)
    }

    // ================= hentai2read =================
    console.log('\n===== Hentai2Read (Filtered) =====')
    {
        const s = load('Hentai2Read', 'Hentai2Read', 1200)

        const sections = []
        await s.getHomePageSections((sec) => sections.push(sec))
        check('home sections all carry items',
            sections.length === 3 && sections.every((x) => Array.isArray(x.items) && x.items.length > 0),
            sections.map((x) => `${x.title}:${x.items?.length}`).join(', '))

        let meta = undefined
        const ids = []
        for (let i = 0; i < 2; i++) {
            const res = await s.getViewMoreItems('latest', meta)
            for (const t of res.results) ids.push(t.mangaId)
            meta = res.metadata
            if (!meta) break
        }
        check('listing paginates without duplicates',
            ids.length > 20 && new Set(ids).size === ids.length,
            `${ids.length} items, ${new Set(ids).size} unique`)

        // Listing cards on this site carry no category data, so a banned
        // title can sit on a listing and only the gate stops it -- which
        // means the details sample must walk past gated entries. How many got
        // gated is reported: that is the gate doing its job.
        let id = undefined
        let d = undefined
        let gated = 0
        for (const candidate of ids.slice(0, 6)) {
            try {
                d = await s.getMangaDetails(candidate)
                id = candidate
                break
            } catch (error) {
                if (/excluded by your settings/i.test(error.message)) { gated++; continue }
                throw error
            }
        }
        note('listing entries the gate refused', `${gated} of the first ${Math.min(6, ids.length)}`)
        check('a non-excluded title opens', id != undefined && d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('http'),
            id != undefined ? `"${d.mangaInfo.titles[0]?.slice(0, 50)}" cats=${d.mangaInfo.tags[0]?.tags?.length ?? 0}` : 'all six gated')

        const chapters = await s.getChapters(id)
        check('chapters parse', chapters.length > 0, `${chapters.length} chapters`)

        const pages = await s.getChapterDetails(id, chapters[0].id)
        check('pages resolve', pages.pages.length > 0 && pages.pages.every((p) => p.startsWith('https://')),
            `${pages.pages.length} pages from ${new URL(pages.pages[0]).host}`)
        const img = await probeImage(pages.pages[0], 'https://hentai2read.com/')
        if (img.unreachable) note('image CDN unreachable from here', `${new URL(pages.pages[0]).host}: ${img.type}`)
        else check('first page fetches real image bytes', img.ok, `${img.status} ${img.type}`)

        // Ground truth from the site's own Yaoi category listing, read off
        // the book-grid cards (the page also carries sidebar widgets of
        // unrelated titles, which is what an anchor-level scrape picks up).
        // Each candidate is then verified against its OWN meta list before
        // being asserted on.
        const yaoiHtml = await (await fetch('https://hentai2read.com/hentai-list/category/Yaoi/', { headers: { 'user-agent': UA } })).text()
        const gridCards = [...yaoiHtml.matchAll(/data-tags="([\d-]*)"[\s\S]{0,1500}?href="https:\/\/hentai2read\.com\/([a-z0-9_]+)\/"/g)]
        check('the Yaoi listing is tagged 27 on every card',
            gridCards.length > 10 && gridCards.every((m) => m[1].split('-').includes('27')),
            `${gridCards.length} cards, all carry tag 27`)

        let yaoiSlug = undefined
        for (const m of gridCards.slice(0, 5)) {
            const page = await (await fetch(`https://hentai2read.com/${m[2]}/`, { headers: { 'user-agent': UA } })).text()
            const meta = /<ul class="list list-simple-mini">([\s\S]*?)<\/ul>/.exec(page)?.[1] ?? ''
            if (/\/hentai-list\/category\/Yaoi\//.test(meta)) { yaoiSlug = m[2]; break }
        }

        if (yaoiSlug) {
            await expectGateThrow(`a verified yaoi title refuses to open (${yaoiSlug})`, () => s.getMangaDetails(yaoiSlug))

            // And the listing filter must keep it off the Yaoi listing itself.
            const filtered = await s.getSearchResults({ title: '', includedTags: [{ id: 'cat:Yaoi' }], excludedTags: [], parameters: {} }, undefined)
            check('the Yaoi category listing comes back empty',
                filtered.results.length === 0,
                `${filtered.results.length} survivors`)
        } else {
            note('no verified yaoi title found', 'gate not exercised')
        }

        const search = await s.getSearchResults({ title: 'sister', includedTags: [], excludedTags: [], parameters: {} }, undefined)
        check('search returns results', search.results.length > 0, `${search.results.length} results`)

        const tags = await s.getSearchTags()
        const offered = (tags[0]?.tags ?? []).map((t) => t.label)
        check('category catalog offered with banned entries scrubbed',
            offered.length > 50 && !offered.some((label) => /yaoi|boy.?love/i.test(label)),
            `${offered.length} categories, yaoi absent`)
    }

    console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
