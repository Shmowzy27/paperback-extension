/*
 * Runs the built MangaKatana (18+) bundle against the live site.
 *
 * The point of this source is the content rule: only titles carrying adult,
 * ecchi, erotica or sexual violence; never gender bender, yaoi or shounen-ai.
 * So beyond the usual listing/details/chapters/pages checks, every surface is
 * audited against that rule by fetching real genre data.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const GAP_MS = Number(process.env.MK_GAP_MS ?? 1100)

const identity = (x) => x
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ ...i }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request, retry) => {
            const gap = Math.max(1000 / (opts.requestsPerSecond || 3), GAP_MS)
            let lastError
            for (let attempt = 0; attempt <= (retry ?? 1); attempt++) {
                const wait = Math.max(0, (global.__last || 0) + gap - Date.now())
                if (wait > 0) await new Promise((r) => setTimeout(r, wait))
                global.__last = Date.now()
                try {
                    const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
                    const res = await fetch(req.url, {
                        method: req.method || 'GET',
                        headers: { accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(req.headers || {}) },
                        redirect: 'follow',
                        signal: AbortSignal.timeout(opts.requestTimeout || 30000)
                    })
                    const body = await res.text()
                    // The site drops connections under load; an empty 200 is a drop.
                    if (res.ok && body.length === 0) throw new Error('empty response body')
                    return { data: body, status: res.status, headers: {}, request: req }
                } catch (error) { lastError = error }
            }
            throw lastError
        }
    })
}

const path = require('node:path')
const { Sources } = require(path.join(__dirname, '..', 'bundles', 'MangaKatana', 'source.js'))

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

const WANTED = ['adult', 'ecchi', 'erotica', 'sexual-violence']
const BANNED = ['gender-bender', 'yaoi', 'shounen-ai']
const genreSlugsOf = (details) => (details.mangaInfo.tags[0]?.tags ?? []).map((t) => t.id)
const admitted = (slugs) => WANTED.some((g) => slugs.includes(g)) && !BANNED.some((g) => slugs.includes(g))

;(async () => {
    const s = new Sources.MangaKatana()

    // ---- home sections ----
    const sections = []
    await s.getHomePageSections((sec) => sections.push(sec))
    check('home sections all carry items',
        sections.length === 3 && sections.every((x) => Array.isArray(x.items) && x.items.length > 0),
        sections.map((x) => `${x.title}:${x.items?.length}`).join(', '))
    check('tiles carry slug.id, cover and title',
        sections[0].items.every((t) => /^[^/?#]+\.\d+$/.test(t.mangaId) && t.image.startsWith('http') && t.title.length > 0),
        JSON.stringify(sections[0].items[0]).slice(0, 120))

    // ---- pagination without duplicates ----
    let meta
    const ids = []
    for (let i = 0; i < 3; i++) {
        const res = await s.getViewMoreItems('latest', meta)
        for (const t of res.results) ids.push(t.mangaId)
        meta = res.metadata
        if (!meta) break
    }
    check('listing paginates without duplicate ids',
        ids.length > 20 && new Set(ids).size === ids.length,
        `${ids.length} items, ${new Set(ids).size} unique`)

    // ---- the content rule, audited with real genre data ----
    // Three titles from different pages of the listing are opened and their
    // genre links checked: each must carry a wanted genre and no banned one.
    const sample = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]]
    for (const id of sample) {
        const d = await s.getMangaDetails(id)
        const slugs = genreSlugsOf(d)
        check(`listing title respects the 18+ rule (${id.slice(0, 30)})`,
            admitted(slugs), slugs.join(','))
    }

    // ---- details / chapters / pages ----
    const d = await s.getMangaDetails(ids[0])
    check('details parse',
        d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('http') && genreSlugsOf(d).length > 0,
        `"${d.mangaInfo.titles[0]}" status=${d.mangaInfo.status} genres=${genreSlugsOf(d).length}`)

    const chapters = await s.getChapters(ids[0])
    check('chapters parse', chapters.length > 0, `${chapters.length} chapters`)
    check('chapters ascend',
        chapters.length < 2 || chapters[0].chapNum <= chapters[chapters.length - 1].chapNum,
        `${chapters[0]?.chapNum} … ${chapters[chapters.length - 1]?.chapNum}`)

    const dated = chapters.filter((c) => c.time instanceof Date && !isNaN(c.time.getTime()))
    check('chapters carry real dates', dated.length === chapters.length && dated.length > 0,
        `${dated.length}/${chapters.length} dated, newest ${chapters[chapters.length - 1]?.time?.toISOString()?.slice(0, 10)}`)

    const pages = await s.getChapterDetails(ids[0], chapters[chapters.length - 1].id)
    check('a chapter resolves page URLs',
        pages.pages.length > 1 && pages.pages.every((p) => p.startsWith('https://')),
        `${pages.pages.length} pages from ${new URL(pages.pages[0]).host}`)

    // The CDN answers application/octet-stream rather than image/*, so the
    // probe checks magic bytes instead of the content type.
    const probe = await fetch(pages.pages[0], { headers: { 'user-agent': UA, referer: 'https://mangakatana.com/' } })
    const head = Buffer.from(await probe.arrayBuffer()).subarray(0, 12)
    const looksImage = (head[0] === 0xFF && head[1] === 0xD8)
        || head.toString('ascii', 1, 4) === 'PNG'
        || head.toString('ascii', 8, 12) === 'WEBP'
        || head.toString('ascii', 4, 8) === 'ftyp'
    check('first page fetches real image bytes', probe.ok && looksImage,
        `${probe.status} ${probe.headers.get('content-type')} ${head.toString('hex').slice(0, 8)}`)

    // ---- search is post-filtered ----
    // "wife" is known to surface titles carrying gender-bender and shounen-ai
    // on the site's own search; none may survive here.
    const search = await s.getSearchResults({ title: 'wife', includedTags: [], excludedTags: [], parameters: {} }, undefined)
    check('search returns results', search.results.length > 0, `${search.results.length} results`)
    for (const r of search.results.slice(0, 2)) {
        const sd = await s.getMangaDetails(r.mangaId)
        check(`search result respects the 18+ rule (${r.mangaId.slice(0, 30)})`,
            admitted(genreSlugsOf(sd)), genreSlugsOf(sd).join(','))
    }

    // ---- tag browse ----
    const tags = await s.getSearchTags()
    check('18+ genres offered, exclusions shown',
        tags[0]?.tags.length === 4 && tags[1]?.tags.length === 3,
        `${tags[0]?.tags.map((t) => t.id).join(',')} | ${tags[1]?.tags.map((t) => t.id).join(',')}`)

    const byGenre = await s.getSearchResults({ title: '', includedTags: [tags[0].tags[0]], excludedTags: [], parameters: {} }, undefined)
    check('browsing a genre tag returns results', byGenre.results.length > 0,
        `${tags[0].tags[0].id} -> ${byGenre.results.length} results`)

    console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
