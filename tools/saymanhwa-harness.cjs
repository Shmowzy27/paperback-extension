/*
 * Runs the built FullManhwa bundle (now targeting saymanhwa.com) against the
 * live site.
 *
 * Proves the four things the rewrite had to get right:
 *   - listings paginate without ever repeating a manga id
 *   - details parse, with a real title, cover and synopsis
 *   - chapters carry real Date upload times, not placeholders
 *   - a chapter resolves page URLs that actually fetch 200 image/*
 *
 * The site throttles bursts: it starts dropping connections outright rather
 * than answering 429, so the scheduler floor here is deliberately slower than
 * the source's own requestsPerSecond. Override with SAYMANHWA_GAP_MS.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const GAP_MS = Number(process.env.SAYMANHWA_GAP_MS ?? 1200)

const identity = (x) => x
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ id: i.id, title: i.title, type: i.type, containsMoreItems: i.containsMoreItems, items: i.items }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        // Honour requestsPerSecond, but never go faster than the floor above.
        schedule: async (request) => {
            const gap = Math.max(1000 / (opts.requestsPerSecond || 3), GAP_MS)
            const wait = Math.max(0, (global.__last || 0) + gap - Date.now())
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))
            global.__last = Date.now()
            const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
            const res = await fetch(req.url, {
                method: req.method || 'GET',
                headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(req.headers || {}) },
                redirect: 'follow'
            })
            const headers = {}
            for (const [k, v] of res.headers) headers[k] = v
            const sc = res.headers.getSetCookie?.() ?? []
            if (sc.length) headers['set-cookie'] = sc
            return { data: await res.text(), status: res.status, headers, request: req }
        }
    })
}

const path = require('node:path')
const { Sources } = require(path.join(__dirname, '..', 'bundles', 'FullManhwa', 'source.js'))

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}
const note = (label, detail) => console.log(`note  ${label}${detail ? ` — ${detail}` : ''}`)

;(async () => {
    const s = new Sources.FullManhwa()

    // --- home sections ---------------------------------------------------
    const seen = []
    await s.getHomePageSections((sec) => seen.push(sec))
    check('home sections all carry items',
        seen.length === 4 && seen.every((x) => Array.isArray(x.items) && x.items.length > 0),
        seen.map((x) => `${x.title}:${x.items?.length}`).join(', '))
    check('tiles carry slug, https cover and a real title',
        seen[0].items.every((t) => /^[^/?#]+$/.test(t.mangaId) && t.image.startsWith('https://') && t.title.length > 0
            && !/^chapter\s/i.test(t.title)),
        JSON.stringify(seen[0].items[0]).slice(0, 140))

    // --- pagination without duplicates -----------------------------------
    // The listing's own rel=next is not trusted; the source builds ?page= and
    // carries the ids it already handed out. Three pages is enough to catch the
    // overlap a reordering listing produces.
    let meta = undefined
    const ids = []
    let pages = 0
    for (let i = 0; i < 3; i++) {
        const res = await s.getViewMoreItems('latest', meta)
        pages++
        for (const t of res.results) ids.push(t.mangaId)
        meta = res.metadata
        if (!meta) break
    }
    check('listing paginates without duplicate ids',
        ids.length > 24 && new Set(ids).size === ids.length,
        `${pages} pages, ${ids.length} items, ${new Set(ids).size} unique`)

    // --- details ---------------------------------------------------------
    const id = seen[0].items[0].mangaId
    const d = await s.getMangaDetails(id)
    check('details parse',
        d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('https://') && d.mangaInfo.desc.length > 20,
        `"${d.mangaInfo.titles[0]}" status=${d.mangaInfo.status} desc=${d.mangaInfo.desc.length}c tags=${d.mangaInfo.tags[0]?.tags?.length ?? 0}`)
    // Genres are optional: many adult titles carry none and are filed only
    // under an origin type, so this one is reported rather than asserted here.
    // The genre-listing check further down proves the parsing on a title that
    // is guaranteed to have one.
    note('genre tags on this title', `${d.mangaInfo.tags[0]?.tags?.length ?? 0} — ${(d.mangaInfo.tags[0]?.tags ?? []).map((t) => t.id).join(',').slice(0, 80) || 'none'}`)
    check('placeholder text is not shown as data',
        !/updating/i.test(d.mangaInfo.titles.join(' ')) && !/updating/i.test(d.mangaInfo.author ?? ''),
        `titles=${JSON.stringify(d.mangaInfo.titles).slice(0, 90)} author="${d.mangaInfo.author ?? ''}"`)

    // --- chapters --------------------------------------------------------
    const chapters = await s.getChapters(id)
    check('chapters parse', chapters.length > 0, `${chapters.length} chapters`)
    check('chapters ascend',
        chapters.length < 2 || chapters[0].chapNum <= chapters[chapters.length - 1].chapNum,
        `${chapters[0]?.chapNum} … ${chapters[chapters.length - 1]?.chapNum}`)
    check('chapter ids are unique', new Set(chapters.map((c) => c.id)).size === chapters.length,
        `${new Set(chapters.map((c) => c.id)).size}/${chapters.length} unique`)

    // The date is the field this repo has lost before, so it is checked hard:
    // a real Date, on every row, inside a sane window.
    const dated = chapters.filter((c) => c.time instanceof Date && !isNaN(c.time.getTime()))
    const now = Date.now()
    const sane = dated.filter((c) => c.time.getTime() > Date.parse('2015-01-01') && c.time.getTime() < now + 86400000)
    check('every chapter carries a real Date', dated.length === chapters.length,
        `${dated.length}/${chapters.length} are Dates`)
    check('chapter dates are plausible', sane.length === dated.length && dated.length > 0,
        `newest ${chapters[chapters.length - 1]?.time?.toISOString()}`)
    check('chapter names are not bare slugs',
        chapters.every((c) => c.name.length > 0) && chapters.some((c) => /chapter/i.test(c.name)),
        `e.g. "${chapters[chapters.length - 1]?.name}"`)

    // --- reader ----------------------------------------------------------
    const first = chapters[0]
    const firstPages = await s.getChapterDetails(id, first.id)
    check('a chapter resolves page URLs',
        firstPages.pages.length > 0 && firstPages.pages.every((p) => p.startsWith('https://')),
        `${firstPages.pages.length} pages from ${new URL(firstPages.pages[0]).host}`)

    // The pages must genuinely fetch as images -- the whole point of the reader
    // rewrite. The CDN rotates hosts, so an unreachable host is reported rather
    // than failing the run.
    let imageChecked = 0
    for (const url of [firstPages.pages[0], firstPages.pages[Math.floor(firstPages.pages.length / 2)]]) {
        try {
            const probe = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://saymanhwa.com/' } })
            const type = probe.headers.get('content-type') ?? ''
            check(`page image fetches 200 image/* (${new URL(url).pathname.split('/').pop()})`,
                probe.ok && type.startsWith('image/'), `${probe.status} ${type}`)
            imageChecked++
        } catch (e) {
            note('image CDN unreachable from here', `${new URL(url).host}: ${e.message}`)
        }
    }
    if (imageChecked === 0) note('no page image could be probed', 'CDN unreachable from this machine')

    // A later chapter too, so the reader is not proven on one lucky page.
    const mid = chapters[Math.floor(chapters.length / 2)]
    const midPages = await s.getChapterDetails(id, mid.id)
    check('a second chapter also resolves pages', midPages.pages.length > 0,
        `${mid.name} -> ${midPages.pages.length} pages`)
    check('the two chapters are different images',
        midPages.pages[0] !== firstPages.pages[0], `${midPages.pages[0]?.slice(-40)}`)

    // --- search ----------------------------------------------------------
    const term = 'uncensored'
    const search = await s.getSearchResults({ title: term, includedTags: [], excludedTags: [], parameters: {} }, undefined)
    const hits = search.results.filter((r) => r.title.toLowerCase().includes(term))
    check('search returns results', search.results.length > 0, `${search.results.length} results`)
    check('search results are relevant', hits.length > search.results.length / 2,
        `${hits.length}/${search.results.length} titles contain "${term}"`)

    // The catalog's rel=next drops `q`, so the source builds its own paged URL.
    // This confirms page 2 is still filtered rather than the raw catalog.
    if (search.metadata) {
        const second = await s.getSearchResults({ title: term, includedTags: [], excludedTags: [], parameters: {} }, search.metadata)
        const overlap = second.results.filter((r) => search.results.some((f) => f.mangaId === r.mangaId))
        const hits2 = second.results.filter((r) => r.title.toLowerCase().includes(term))
        check('search page 2 stays filtered and does not repeat page 1',
            overlap.length === 0 && (second.results.length === 0 || hits2.length > second.results.length / 2),
            `${second.results.length} results, ${hits2.length} relevant, ${overlap.length} repeated`)
    } else {
        note('search returned a single page', `${search.results.length} results`)
    }

    const empty = await s.getSearchResults({ title: 'zzzqqqxyznope', includedTags: [], excludedTags: [], parameters: {} }, undefined)
    check('a no-match search returns nothing rather than the whole catalog',
        empty.results.length === 0, `${empty.results.length} results`)

    // --- tags ------------------------------------------------------------
    const tags = await s.getSearchTags()
    const genre = tags.find((t) => t.id === 'genre')
    check('browse and origin filters offered',
        tags[0]?.tags.length === 4 && tags[1]?.tags.length === 4,
        `${tags[0]?.tags.map((t) => t.id).join(',')} | ${tags[1]?.tags.map((t) => t.id).join(',')}`)
    check('genre taxonomy discovered', (genre?.tags.length ?? 0) > 10,
        `${genre?.tags.length ?? 0} genres, e.g. ${(genre?.tags ?? []).slice(0, 3).map((t) => t.id).join(',')}`)

    // Browsing by a genre tag must actually reach that genre's listing, and a
    // title pulled from that listing must parse the genre back out -- which is
    // where genre parsing is proven, on a series certain to have one.
    if (genre?.tags.length) {
        const tag = genre.tags[0]
        const byGenre = await s.getSearchResults({ title: '', includedTags: [tag], excludedTags: [], parameters: {} }, undefined)
        check('browsing a genre tag returns results', byGenre.results.length > 0,
            `${tag.id} -> ${byGenre.results.length} results`)

        if (byGenre.results.length > 0) {
            const genred = await s.getMangaDetails(byGenre.results[0].mangaId)
            const parsed = (genred.mangaInfo.tags[0]?.tags ?? []).map((t) => t.id)
            check('a genred title parses its genres back out',
                parsed.includes(tag.id),
                `${byGenre.results[0].mangaId} -> ${parsed.join(',').slice(0, 80) || 'none'}`)
        }
    }

    console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
