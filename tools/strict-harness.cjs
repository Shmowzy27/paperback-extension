/*
 * Exercises the built bundle against the live site through a stub of the app.
 *
 * The stub deliberately invents no defaults: an earlier version filled in
 * `items: []` for home sections when the field was omitted, which the app does
 * not do, so a crashing bundle passed here and failed on device.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const identity = (x) => x

global.App = {
    createRequest: identity,
    createPartialSourceManga: identity,
    createSourceManga: identity,
    createMangaInfo: identity,
    createTag: identity,
    createTagSection: identity,
    createChapter: identity,
    createChapterDetails: identity,
    createPagedResults: identity,
    createHomeSection: (i) => ({
        id: i.id, title: i.title, type: i.type,
        containsMoreItems: i.containsMoreItems, items: i.items
    }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request) => {
            const req = opts.interceptor
                ? await opts.interceptor.interceptRequest({ ...request })
                : request
            const res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {} })
            return { data: await res.text(), status: res.status, headers: {}, request: req }
        }
    })
}

const { Sources } = require(require('node:path').join(__dirname, '..', 'bundles', 'HentaiNexus', 'source.js'))

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

;(async () => {
    const source = new Sources.HentaiNexus()

    // Home sections: the app reads .items on everything it receives.
    const seen = []
    await source.getHomePageSections((section) => seen.push(section))
    check('home sections carry items', seen.every((s) => Array.isArray(s.items)),
        seen.map((s) => `${s.title}:${Array.isArray(s.items) ? s.items.length : 'UNDEFINED'}`).join(', '))

    // Grouping: a numbered series collapses to a single entry.
    const search = await source.getSearchResults(
        { title: 'Bedded by Your Best Friend', includedTags: [], excludedTags: [], parameters: {} },
        undefined
    )
    const merged = search.results.filter((r) => /^Bedded by Your Best Friend$/i.test(r.title))
    check('numbered volumes collapse to one entry', merged.length === 1,
        `${search.results.length} entries, ${merged.length} matching the base title`)
    check('merged entry uses a series id', merged[0]?.mangaId?.startsWith('s:'), merged[0]?.mangaId)

    // Paging is keyed on raw cards, not the shrunken grouped count: a full page
    // that groups down to fewer entries must still offer a next page.
    const broad = await source.getSearchResults(
        { title: 'tag:"glasses"', includedTags: [], excludedTags: [], parameters: {} },
        undefined
    )
    check('grouping does not truncate pagination', broad.metadata?.page === 2,
        `${broad.results.length} grouped entries, next=${JSON.stringify(broad.metadata)}`)

    const seriesId = merged[0].mangaId
    const details = await source.getMangaDetails(seriesId)
    check('series details use the base title', details.mangaInfo.titles[0] === 'Bedded by Your Best Friend',
        details.mangaInfo.titles[0])

    const chapters = await source.getChapters(seriesId)
    const nums = chapters.map((c) => c.chapNum)
    check('every volume became a chapter', chapters.length >= 5, `${chapters.length} chapters: ${nums.join(',')}`)
    check('chapters are in volume order', nums.every((n, i) => i === 0 || nums[i - 1] < n), nums.join(','))
    check('chapter ids are gallery ids', chapters.every((c) => /^\d+$/.test(c.id)))

    // Reading a middle volume must resolve to that gallery, not the series.
    const middle = chapters[2]
    const pages = await source.getChapterDetails(seriesId, middle.id)
    check('a middle volume decodes its own pages', pages.pages.length > 0,
        `vol ${middle.chapNum} (gallery ${middle.id}) -> ${pages.pages.length} pages`)

    // Keyword numbering ("Ch. 4", "#4", "Vol. 4") must group too, and must not
    // leave the keyword stranded on the end of the series name.
    const kw = await source.getSearchResults(
        { title: 'Bridesmaids', includedTags: [], excludedTags: [], parameters: {} },
        undefined
    )
    const kwEntry = kw.results.find((r) => /^Bridesmaids$/i.test(r.title))
    check('keyword-numbered series groups cleanly', kwEntry != undefined,
        kw.results.map((r) => r.title).join(' | '))
    if (kwEntry) {
        const kwChapters = await source.getChapters(kwEntry.mangaId)
        check('keyword-numbered series has multiple chapters', kwChapters.length > 1,
            `${kwChapters.length} chapters: ${kwChapters.map((c) => c.chapNum).join(',')}`)
    }

    // Standalone galleries must keep working for pre-merge library entries.
    const legacy = await source.getMangaDetails('1')
    const legacyChapters = await source.getChapters('1')
    check('legacy numeric id still resolves', legacy.mangaInfo.titles[0]?.length > 0 && legacyChapters.length === 1,
        `${legacy.mangaInfo.titles[0]} / ${legacyChapters.length} chapter`)

    process.exit(failures > 0 ? 1 : 0)
})().catch((error) => {
    console.error(`FAILED: ${error.message}`)
    process.exit(1)
})
