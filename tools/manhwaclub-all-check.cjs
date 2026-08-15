const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const identity = (x) => x
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ ...i }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request) => {
            const gap = 1000 / (opts.requestsPerSecond || 3)
            const wait = Math.max(0, (global.__last || 0) + gap - Date.now())
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))
            global.__last = Date.now()
            const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
            const res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {}, body: req.data })
            return { data: await res.text(), status: res.status, headers: {}, request: req }
        }
    })
}
const path = require('node:path')
const load = (d, c) => new (require(path.join(__dirname, '..', 'bundles', d, 'source.js')).Sources[c])()
let bad = 0
const check = (l, ok, d) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); if (!ok) bad++ }
;(async () => {
    const all = load('ManhwaClubAll', 'ManhwaClubAll')
    const en = load('ManhwaClub', 'ManhwaClub')
    const raw = load('ManhwaClubRaw', 'ManhwaClubRaw')

    const S = 'manitto'
    const a = await all.getChapters(S)
    const e = await en.getChapters(S)
    const r = await raw.getChapters(S)

    const groups = [...new Set(a.map((c) => c.group))].sort()
    check('combined source carries both tracks', groups.join(',') === 'Raw,Translated', `groups: ${groups.join(', ')}`)
    check('combined equals English + Raw', a.length === e.length + r.length, `${a.length} = ${e.length} + ${r.length}`)
    check('no duplicate chapter ids', new Set(a.map((c) => c.id)).size === a.length, `${a.length} chapters`)

    const pages = await all.getChapterDetails(S, a[0].id)
    check('chapters resolve pages', pages.pages.length > 0, `${a[0].name} -> ${pages.pages.length} pages`)

    const home = []
    await all.getHomePageSections((s) => home.push(s))
    check('home sections populate', home.length === 3 && home.every((s) => s.items.length > 0),
        home.map((s) => `${s.title}:${s.items.length}`).join(', '))
    process.exit(bad > 0 ? 1 : 0)
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1) })
