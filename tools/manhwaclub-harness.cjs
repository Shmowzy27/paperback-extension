const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const identity = (x) => x
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ id: i.id, title: i.title, type: i.type, containsMoreItems: i.containsMoreItems, items: i.items }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request) => {
            const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
            const res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {}, body: req.data })
            return { data: await res.text(), status: res.status, headers: {}, request: req }
        }
    })
}
const path = require('node:path')
const { Sources } = require(path.join(__dirname, '..', 'bundles', 'ManhwaClub', 'source.js'))
let failures = 0
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
;(async () => {
    const s = new Sources.ManhwaClub()
    const seen = []
    await s.getHomePageSections((sec) => seen.push(sec))
    check('home sections carry items', seen.length === 3 && seen.every((x) => Array.isArray(x.items) && x.items.length > 0),
        seen.map((x) => `${x.title}:${x.items?.length}`).join(', '))
    check('tiles have slug + cover', seen[0].items.every((t) => /^[a-z0-9-]+$/.test(t.mangaId) && t.image.startsWith('http')),
        JSON.stringify(seen[0].items[0]).slice(0, 120))

    const id = seen[0].items[0].mangaId
    const d = await s.getMangaDetails(id)
    check('details parse', d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('http'),
        `"${d.mangaInfo.titles[0]}" status=${d.mangaInfo.status} genres=${d.mangaInfo.tags[0]?.tags.length ?? 0} desc=${d.mangaInfo.desc.length}c`)

    const chapters = await s.getChapters(id)
    check('chapters load via ajax', chapters.length > 1, `${chapters.length} chapters, first="${chapters[0]?.name}" num=${chapters[0]?.chapNum}`)
    check('chapters ascend', chapters[0].chapNum <= chapters[chapters.length - 1].chapNum,
        `${chapters[0]?.chapNum} … ${chapters[chapters.length - 1]?.chapNum}`)

    const pages = await s.getChapterDetails(id, chapters[0].id)
    check('pages resolve', pages.pages.length > 0 && pages.pages[0].startsWith('http'), `${pages.pages.length} pages`)
    const probe = await fetch(pages.pages[0], { headers: { 'user-agent': UA, referer: 'https://manhwaclub.net/' } })
    check('first page image fetches', probe.ok, `${probe.status} ${probe.headers.get('content-type')}`)

    const search = await s.getSearchResults({ title: 'love', includedTags: [], excludedTags: [], parameters: {} }, undefined)
    check('search returns results', search.results.length > 0, `${search.results.length} results`)

    const genres = await s.getSearchTags()
    check('genre filters offered', genres[0]?.tags.length > 5, `${genres[0]?.tags.length} genres`)
    const byGenre = await s.getSearchResults({ includedTags: [genres[0].tags[0]], excludedTags: [], parameters: {} }, undefined)
    check('genre filter returns results', byGenre.results.length > 0, `${genres[0].tags[0].id} -> ${byGenre.results.length}`)

    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
