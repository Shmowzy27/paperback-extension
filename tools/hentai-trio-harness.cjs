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

const probeImage = async (url, referer) => {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: referer } })
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, 12)
    const looksImage = (head[0] === 0xFF && head[1] === 0xD8)
        || head.toString('ascii', 1, 4) === 'PNG'
        || head.toString('ascii', 8, 12) === 'WEBP'
        || head.toString('ascii', 4, 8) === 'ftyp'
        || (head[0] === 0x47 && head[1] === 0x49)
    return { ok: res.ok && looksImage, status: res.status, type: res.headers.get('content-type') }
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
            !tagLabels.some((label) => /^(yaoi|males only|ugly bastard|bald)$/i.test(label)),
            tagLabels.filter((l) => /yaoi|males only|ugly bastard|bald/i.test(l)).join(',') || 'clean')

        const chapters = await s.getChapters(id)
        check('gallery is a single dated chapter',
            chapters.length === 1 && chapters[0].time instanceof Date && !isNaN(chapters[0].time.getTime()),
            `${chapters.length} chapter, ${chapters[0]?.time?.toISOString()?.slice(0, 10)}`)

        const pages = await s.getChapterDetails(id, 'gallery')
        check('pages resolve', pages.pages.length > 1 && pages.pages.every((p) => p.startsWith('https://')),
            `${pages.pages.length} pages from ${new URL(pages.pages[0]).host}`)
        const img = await probeImage(pages.pages[0], 'https://nhentai.net/')
        check('first page fetches real image bytes', img.ok, `${img.status} ${img.type}`)

        // Gallery 674659 is tagged yaoi + males only on the live site; it was
        // the gallery the banned ids were verified against.
        await expectGateThrow('a yaoi gallery refuses to open', () => s.getMangaDetails('674659'))

        const search = await s.getSearchResults({ title: 'milf', includedTags: [], excludedTags: [], parameters: {} }, undefined)
        check('search returns results', search.results.length > 0, `${search.results.length} results`)

        const tags = await s.getSearchTags()
        check('language filters and visible exclusions offered',
            tags[0]?.tags.length === 3 && tags[1]?.tags.length === 4,
            `${tags[0]?.tags.map((t) => t.id).join(',')} | ${tags[1]?.tags.length} exclusions`)
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
        check('first page fetches real image bytes', img.ok, `${img.status} ${img.type}`)

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
        check('first page fetches real image bytes', img.ok, `${img.status} ${img.type}`)

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
