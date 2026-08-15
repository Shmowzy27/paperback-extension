/*
 * Covers three reports:
 *   - FullManhwa never showed adult titles (they live at /uncensored)
 *   - both sources should surface a latest-updates listing
 *   - ManhwaClub should separate raw from translated with group buttons
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
            const res = await fetch(req.url, {
                method: req.method || 'GET',
                headers: { accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(req.headers || {}) },
                body: req.data
            })
            return { data: await res.text(), status: res.status, headers: {}, request: req }
        }
    })
}

const path = require('node:path')
const bundle = (name) => require(path.join(__dirname, '..', 'bundles', name, 'source.js')).Sources

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

;(async () => {
    // ---- FullManhwa ----
    const fm = new (bundle('FullManhwa').FullManhwa)()
    const fmSections = []
    await fm.getHomePageSections((s) => fmSections.push(s))

    const titles = fmSections.map((s) => s.title)
    check('FullManhwa has a latest listing', titles.some((t) => /latest/i.test(t)), titles.join(', '))
    check('FullManhwa surfaces the adult listing', titles.some((t) => /uncensored|18\+/i.test(t)), titles.join(', '))
    check('every FullManhwa section has items', fmSections.every((s) => Array.isArray(s.items) && s.items.length > 0),
        fmSections.map((s) => `${s.title}:${s.items?.length}`).join(', '))

    const adult = fmSections.find((s) => /uncensored/i.test(s.title))
    check('adult listing returns adult titles', adult.items.some((t) => /uncensored/i.test(t.mangaId)),
        adult.items.slice(0, 2).map((t) => t.mangaId).join(', '))

    const more = await fm.getViewMoreItems('uncensored', { page: 2 })
    check('adult listing paginates', more.results.length > 0 && more.results[0].mangaId !== adult.items[0].mangaId,
        `page 2 -> ${more.results.length} items`)

    // ---- ManhwaClub ----
    const mc = new (bundle('ManhwaClub').ManhwaClub)()
    const mcSections = []
    await mc.getHomePageSections((s) => mcSections.push(s))
    check('ManhwaClub has a latest listing', mcSections.some((s) => /latest/i.test(s.title)),
        mcSections.map((s) => s.title).join(', '))

    const chapters = await mc.getChapters('manitto')
    const groups = [...new Set(chapters.map((c) => c.group))]
    check('chapters carry Raw / Translated groups', groups.includes('Raw') && groups.includes('Translated'),
        `groups: ${groups.join(', ')}`)
    check('raw chapters are tagged in the title', chapters.filter((c) => c.group === 'Raw').every((c) => c.name.includes('[RAW]')),
        chapters.find((c) => c.group === 'Raw')?.name)
    check('translated chapters are not tagged', chapters.filter((c) => c.group === 'Translated').every((c) => !c.name.includes('[RAW]')),
        chapters.find((c) => c.group === 'Translated')?.name)

    process.exit(failures > 0 ? 1 : 0)
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1) })
