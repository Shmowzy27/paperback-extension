/*
 * Runs the built HentaiNexus bundle against the live site to cover two reports:
 *
 *   - opening many galleries failed with `No volumes found for "..."`. The
 *     series id is the title, and the site's search rejects a quoted phrase
 *     containing punctuation, so any title carrying a dash never found itself.
 *
 *   - an artist's works showed the same series twice while scrolling. Grouping
 *     sees one page at a time, so a series straddling a page boundary was
 *     emitted again under the same id.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const GAP_MS = Number(process.env.HN_GAP_MS ?? 900)

const identity = (x) => x
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ ...i }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request) => {
            const gap = Math.max(1000 / (opts.requestsPerSecond || 3), GAP_MS)
            const wait = Math.max(0, (global.__last || 0) + gap - Date.now())
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))
            global.__last = Date.now()
            const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
            const res = await fetch(req.url, {
                method: req.method || 'GET',
                headers: { accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(req.headers || {}) },
                redirect: 'follow'
            })
            return { data: await res.text(), status: res.status, headers: {}, request: req }
        }
    })
}

const path = require('node:path')
const { Sources } = require(path.join(__dirname, '..', 'bundles', 'HentaiNexus', 'source.js'))

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

// The exact title from the bug report: its subtitle is wrapped in dashes, and
// it is a standalone work that sits alongside a genuine numbered series of the
// same name -- so it also proves the two are not conflated.
const DASHED = 'My Wife Started Experimenting -Both Holes Filled While Cosplaying-'
const SERIES = 'My Wife Started Experimenting'
const ARTIST = 'Mahiro Ootori'

;(async () => {
    const s = new Sources.HentaiNexus()

    // ---- the reported crash ----
    let details
    try {
        details = await s.getMangaDetails(`s:${DASHED}`)
        check('a dash-wrapped title opens instead of throwing', true, `"${details.mangaInfo.titles[0]}"`)
    } catch (error) {
        check('a dash-wrapped title opens instead of throwing', false, error.message)
    }

    if (details) {
        const chapters = await s.getChapters(`s:${DASHED}`)
        check('the standalone work reports exactly one volume', chapters.length === 1,
            `${chapters.length} chapter(s)`)
        const pages = await s.getChapterDetails(`s:${DASHED}`, chapters[0].id)
        check('its pages decode', pages.pages.length > 0 && pages.pages[0].startsWith('http'),
            `${pages.pages.length} pages`)
    }

    // ---- the numbered series of the same name is kept separate ----
    const seriesChapters = await s.getChapters(`s:${SERIES}`)
    check('the numbered series of the same name still merges', seriesChapters.length === 6,
        `${seriesChapters.length} volumes: ${seriesChapters.map((c) => c.chapNum).join(',')}`)
    check('the dashed standalone is not swept into the series',
        seriesChapters.every((c) => !/Cosplaying/i.test(c.name)),
        seriesChapters.map((c) => c.name).join(' | ').slice(0, 90))

    // ---- duplicates across pages ----
    // This artist has a series whose volume 5 sits on page 1 and volumes 1-4 on
    // page 2, which is exactly the shape that used to double up.
    const query = { title: `artist:"${ARTIST}"`, includedTags: [], excludedTags: [], parameters: {} }
    const ids = []
    let meta
    let pages = 0
    for (let i = 0; i < 3; i++) {
        const res = await s.getSearchResults(query, meta)
        pages++
        for (const r of res.results) ids.push(r.mangaId)
        meta = res.metadata
        if (!meta) break
    }
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    check('an artist listing never repeats a series across pages', dupes.length === 0,
        `${pages} pages, ${ids.length} entries, ${new Set(ids).size} unique${dupes.length ? ` — repeated: ${[...new Set(dupes)].join(', ')}` : ''}`)
    // Matched exactly: the artist also has a separate "... : Complete
    // Collection" compilation, which is its own work and must stay its own
    // entry rather than being folded into the numbered series.
    const STRADDLING = 's:Slutty Elf Sisters Seeking a Husband'
    check('the straddling series is present exactly once',
        ids.filter((id) => id === STRADDLING).length === 1,
        `${ids.filter((id) => id === STRADDLING).length} occurrence(s)`)
    check('the compilation stays a separate entry',
        ids.some((id) => id === `${STRADDLING}: Complete Collection`),
        ids.filter((id) => id.startsWith(STRADDLING)).join(' | '))

    // ---- season/episode folding ----
    // Seasons fold into the work itself, so no bare season or episode should
    // survive as an entry of its own.
    // Anthologies keep "Season N" in their own name and are meant to stay
    // separate, so they are not strays.
    const strays = ids.filter((id) => /season\s*\d|ep\.?\s*\d/i.test(id)
        && !/anthology|side story|collection/i.test(id))
    check('no season or episode is left as its own entry', strays.length === 0,
        strays.join(' | ') || 'none left')

    const harem = await s.getChapters('s:My Harem in Another World')
    const nums = harem.map((c) => c.chapNum)
    check('every season folds into the one series', harem.length >= 12,
        `${harem.length} chapters: ${nums.join(',')}`)
    check('season episodes are ordered across seasons',
        nums.some((n) => n > 2 && n < 3) && nums.some((n) => n > 3 && n < 4)
        && nums.every((n, i) => i === 0 || nums[i - 1] <= n),
        nums.join(','))
    check('the anthologies stay out of the series',
        harem.every((c) => !/anthology|side story/i.test(c.name)),
        harem.map((c) => c.name).find((n) => /anthology|side story/i.test(n)) || 'none present')

    // ---- subtitled sequels ----
    const pkg = ids.filter((id) => /^s:Sex Friend Sisters/i.test(id))
    check('subtitled sequels merge into one entry', pkg.length === 1, pkg.join(' | ') || 'none')

    const pkgChapters = await s.getChapters(pkg[0] || 's:Sex Friend Sisters are a Package Deal')
    check('unnumbered sequels are numbered off in sequence',
        pkgChapters.length === 4 && pkgChapters.map((c) => c.chapNum).join(',') === '1,2,3,4',
        `${pkgChapters.length} chapters: ${pkgChapters.map((c) => c.chapNum).join(',')}`)
    check('the original instalment leads, not a subtitled sequel',
        pkgChapters[0] != undefined && !pkgChapters[0].name.includes(':'),
        pkgChapters[0]?.name)

    console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
