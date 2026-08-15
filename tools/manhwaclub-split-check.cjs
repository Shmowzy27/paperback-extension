/*
 * ManhwaClub ships as two sources, one per release track, so Paperback's
 * cross-source merge can present them as a single title while keeping reading
 * progress and downloads separate. This checks the split is genuinely disjoint.
 */
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
const load = (dir, cls) => new (require(path.join(__dirname, '..', 'bundles', dir, 'source.js')).Sources[cls])()

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

;(async () => {
    const english = load('ManhwaClub', 'ManhwaClub')
    const raw = load('ManhwaClubRaw', 'ManhwaClubRaw')

    const SERIES = 'manitto'
    const en = await english.getChapters(SERIES)
    const ko = await raw.getChapters(SERIES)

    check('English source lists only translated chapters',
        en.length > 0 && en.every((c) => c.group === 'Translated'),
        `${en.length} chapters, groups=${[...new Set(en.map((c) => c.group))].join(',')}`)

    check('Raw source lists only raw chapters',
        ko.length > 0 && ko.every((c) => c.group === 'Raw'),
        `${ko.length} chapters, groups=${[...new Set(ko.map((c) => c.group))].join(',')}`)

    const overlap = en.filter((c) => ko.some((k) => k.id === c.id))
    check('the two tracks share no chapters', overlap.length === 0, `${overlap.length} shared ids`)

    // Both sources must expose the same series ids, or a merge is impossible.
    const enTiles = (await english.getViewMoreItems('latest', { page: 1 })).results
    const koTiles = (await raw.getViewMoreItems('latest', { page: 1 })).results
    const shared = enTiles.filter((t) => koTiles.some((k) => k.mangaId === t.mangaId))
    check('both sources address series by the same id', shared.length > 0,
        `${shared.length} of ${enTiles.length} ids in common`)

    // A series without raws must still read, rather than coming back empty.
    const raws = await raw.getChapters('sugar-daddy-02')
    check('a series lacking raws still returns chapters', raws.length > 0, `${raws.length} chapters`)

    const pages = await raw.getChapterDetails(SERIES, ko[0].id)
    check('raw chapters resolve pages', pages.pages.length > 0, `${ko[0].name} -> ${pages.pages.length} pages`)

    process.exit(failures > 0 ? 1 : 0)
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1) })
