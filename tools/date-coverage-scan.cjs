/*
 * Scans many titles per source and reports any whose chapters come back
 * without a date. Those are the ones the app then stamps with the fetch time,
 * which is what shows up as an identical, drifting "19m" on every row.
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

async function scan(label, source, sectionId, limit) {
    const tiles = (await source.getViewMoreItems(sectionId, { page: 1 })).results.slice(0, limit)
    console.log(`\n${label} — scanning ${tiles.length} titles`)

    let clean = 0
    for (const tile of tiles) {
        try {
            const chapters = await source.getChapters(tile.mangaId)
            const undated = chapters.filter((c) => c.time == undefined).length
            if (chapters.length === 0) {
                console.log(`  EMPTY     ${tile.mangaId}`)
            } else if (undated > 0) {
                console.log(`  UNDATED   ${tile.mangaId} — ${undated}/${chapters.length} without a date`)
            } else {
                clean++
            }
        } catch (error) {
            console.log(`  ERROR     ${tile.mangaId} — ${error.message.slice(0, 70)}`)
        }
    }
    console.log(`  fully dated: ${clean}/${tiles.length}`)
}

;(async () => {
    await scan('ManhwaClub (English)', load('ManhwaClub', 'ManhwaClub'), 'latest', 12)
    await scan('ManhwaClub (Raw)', load('ManhwaClubRaw', 'ManhwaClubRaw'), 'latest', 6)
    await scan('FullManhwa', load('FullManhwa', 'FullManhwa'), 'latest', 12)
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1) })
