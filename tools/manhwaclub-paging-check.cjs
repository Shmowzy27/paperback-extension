/*
 * Covers the two defects reported against ManhwaClub:
 *   - browsing stopped after page 1, because a fixed page-size guess (20) was
 *     larger than the 10 a listing actually serves
 *   - raw and translated releases share a chapter number and collided
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
const { Sources } = require(path.join(__dirname, '..', 'bundles', 'ManhwaClub', 'source.js'))

const KOREAN = String.fromCodePoint(0x1F1F0, 0x1F1F7)
const BRITISH = String.fromCodePoint(0x1F1EC, 0x1F1E7)

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

;(async () => {
    const source = new Sources.ManhwaClub()

    const more1 = await source.getViewMoreItems('latest', { page: 1 })
    check('browse page 1 offers a next page', more1.metadata?.page === 2,
        `${more1.results.length} items, next=${JSON.stringify(more1.metadata)}`)

    const more2 = await source.getViewMoreItems('latest', more1.metadata ?? { page: 2 })
    check('browse page 2 returns different titles',
        more2.results.length > 0 && more2.results[0].mangaId !== more1.results[0].mangaId,
        `p1[0]=${more1.results[0]?.mangaId} p2[0]=${more2.results[0]?.mangaId}`)

    const more5 = await source.getViewMoreItems('latest', { page: 5 })
    check('browse keeps going deep into the listing', more5.results.length > 0,
        `page 5 -> ${more5.results.length} items`)

    const search1 = await source.getSearchResults({ title: 'a', includedTags: [], excludedTags: [], parameters: {} }, undefined)
    const search2 = await source.getSearchResults({ title: 'a', includedTags: [], excludedTags: [], parameters: {} }, search1.metadata)
    check('search pages past page 1',
        search1.metadata?.page === 2 && search2.results.length > 0 && search2.results[0].mangaId !== search1.results[0].mangaId,
        `p1=${search1.results.length} p2=${search2.results.length}`)

    const chapters = await source.getChapters('manitto')
    const raw = chapters.filter((c) => c.langCode === KOREAN)
    const translated = chapters.filter((c) => c.langCode === BRITISH)
    check('raw and translated both kept, separated by language',
        raw.length > 0 && translated.length > 0,
        `${chapters.length} total: ${translated.length} translated, ${raw.length} raw`)

    process.exit(failures > 0 ? 1 : 0)
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1) })
