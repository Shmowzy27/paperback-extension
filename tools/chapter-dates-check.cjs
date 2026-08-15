/*
 * Every chapter reported "7m ago" because no source set Chapter.time, so the
 * app fell back to now. This checks each source now reports real, varied dates.
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

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'none')

/** A source is only fixed if dates exist, differ, and are not all "now". */
const assess = (name, chapters) => {
    const dated = chapters.filter((c) => c.time != undefined)
    const stamps = new Set(dated.map((c) => new Date(c.time).toISOString().slice(0, 10)))
    const nearNow = dated.filter((c) => Math.abs(Date.now() - new Date(c.time).getTime()) < 60 * 60 * 1000)

    check(`${name}: chapters carry dates`, dated.length > 0, `${dated.length}/${chapters.length} dated`)
    check(`${name}: dates are not all identical`, stamps.size > 1, `${stamps.size} distinct days`)
    check(`${name}: dates are not all "now"`, nearNow.length < dated.length,
        `oldest ${day(Math.min(...dated.map((c) => new Date(c.time).getTime())))}, newest ${day(Math.max(...dated.map((c) => new Date(c.time).getTime())))}`)
}

;(async () => {
    assess('ManhwaClub (English)', await load('ManhwaClub', 'ManhwaClub').getChapters('manitto'))
    assess('ManhwaClub (Raw)', await load('ManhwaClubRaw', 'ManhwaClubRaw').getChapters('manitto'))
    assess('FullManhwa', await load('FullManhwa', 'FullManhwa').getChapters('wireless-onahole'))

    // HentaiNexus: a merged series takes its dates from each volume's page.
    const hn = load('HentaiNexus', 'HentaiNexus')
    const series = await hn.getChapters('s:Bedded by Your Best Friend')
    assess('HentaiNexus (series)', series)

    // And a standalone gallery keeps the date it always had.
    const single = await hn.getChapters('1')
    check('HentaiNexus: standalone gallery keeps its date', single[0]?.time != undefined, day(single[0]?.time))

    process.exit(failures > 0 ? 1 : 0)
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1) })
