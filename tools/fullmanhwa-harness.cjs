const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const identity = (x) => x
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ id: i.id, title: i.title, type: i.type, containsMoreItems: i.containsMoreItems, items: i.items }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        // Honour requestsPerSecond; hammering the site trips Cloudflare.
        schedule: async (request) => {
            const gap = 1000 / (opts.requestsPerSecond || 3)
            const wait = Math.max(0, (global.__last || 0) + gap - Date.now())
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))
            global.__last = Date.now()
            const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
            const res = await fetch(req.url, { method: req.method || 'GET', headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(req.headers || {}) }, redirect: 'follow' })
            // Surface real Set-Cookie so the cookie handoff is genuinely exercised.
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
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
;(async () => {
    const s = new Sources.FullManhwa()
    const seen = []
    await s.getHomePageSections((sec) => seen.push(sec))
    check('home sections carry items', seen.length === 3 && seen.every((x) => Array.isArray(x.items) && x.items.length > 0),
        seen.map((x) => `${x.title}:${x.items?.length}`).join(', '))
    check('tiles have slug + cover', seen[0].items.every((t) => /^[a-z0-9-]+$/.test(t.mangaId) && t.image.startsWith('http')),
        JSON.stringify(seen[0].items[0]).slice(0, 110))

    const id = seen[0].items[0].mangaId
    const d = await s.getMangaDetails(id)
    check('details parse', d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('http'),
        `"${d.mangaInfo.titles[0]}" status=${d.mangaInfo.status} desc=${d.mangaInfo.desc.length}c`)

    const chapters = await s.getChapters(id)
    check('chapters parse', chapters.length > 0, `${chapters.length} chapters`)
    check('chapters ascend', chapters.length < 2 || chapters[0].chapNum <= chapters[chapters.length - 1].chapNum,
        `${chapters[0]?.chapNum} … ${chapters[chapters.length - 1]?.chapNum}`)

    // The crux: token + session cookie must be replayed together.
    const pages = await s.getChapterDetails(id, chapters[0].id)
    check('token+cookie yields pages', pages.pages.length > 0 && pages.pages[0].startsWith('http'),
        `${pages.pages.length} pages from ${new URL(pages.pages[0]).host}`)
    // The site rotates image CDNs and some hosts are unreachable from CI, so a
    // connection failure here is reported without failing the run.
    try {
        const probe = await fetch(pages.pages[0], { headers: { 'user-agent': UA, referer: 'https://fullmanhwa.com/' } })
        check('first page image fetches', probe.ok, `${probe.status} ${probe.headers.get('content-type')}`)
    } catch (e) {
        console.log(`warn  image CDN unreachable from here — ${new URL(pages.pages[0]).host}: ${e.message}`)
    }

    // A later chapter too, to prove it is not a one-off session fluke.
    const mid = chapters[Math.floor(chapters.length / 2)]
    const midPages = await s.getChapterDetails(id, mid.id)
    check('a second chapter also resolves', midPages.pages.length > 0,
        `${mid.name} -> ${midPages.pages.length} pages`)

    const search = await s.getSearchResults({ title: 'the', includedTags: [], excludedTags: [], parameters: {} }, undefined)
    check('search returns results', search.results.length > 0, `${search.results.length} results`)

    const tags = await s.getSearchTags()
    check('type filters offered', tags[0]?.tags.length === 3, tags[0]?.tags.map((t) => t.id).join(','))

    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
