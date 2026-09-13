/*
 * Runs the built Hentai3z bundle against the live catalog.
 *
 * hentai3z.cc sits behind an interactive Cloudflare check that no script can
 * pass, so requests are sent to 18porncomic.com instead: the same catalog on
 * the same software (the same titles under the same tags, page for page,
 * verified against hentai3z.cc in a browser), with no check in front. Only the
 * addresses differ -- /hentai/{slug} there is /comic/{slug} here -- and they
 * are rewritten on the way out, so the source itself runs unchanged.
 *
 * Ground truth is read off the site's own pages rather than hardcoded, so the
 * checks track the catalog.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const TWIN = 'https://18porncomic.com'
const GAP_MS = Number(process.env.H3Z_GAP_MS ?? 120)

const rewrite = (url) => url
    .replace('https://hentai3z.cc/hentai/', `${TWIN}/comic/`)
    .replace('https://hentai3z.cc', TWIN)

const identity = (x) => x
let requests = 0

global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ ...i }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request, retry) => {
            let lastError
            for (let attempt = 0; attempt <= (retry ?? 1); attempt++) {
                const wait = Math.max(0, (global.__last || 0) + GAP_MS - Date.now())
                global.__last = Date.now() + wait
                if (wait > 0) await new Promise((r) => setTimeout(r, wait))
                try {
                    requests++
                    const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
                    const res = await fetch(rewrite(req.url), {
                        method: req.method || 'GET',
                        headers: { accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'user-agent': UA },
                        redirect: 'follow',
                        signal: AbortSignal.timeout(opts.requestTimeout || 30000)
                    })
                    const body = await res.text()
                    if (res.ok && body.length === 0) throw new Error('empty response body')
                    return { data: body, status: res.status, headers: {}, request: req }
                } catch (error) { lastError = error }
            }
            throw lastError
        }
    })
}

const path = require('node:path')
const { Sources } = require(path.join(__dirname, '..', 'bundles', 'Hentai3z', 'source.js'))

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}
const note = (label, detail) => console.log(`note  ${label}${detail ? ` — ${detail}` : ''}`)

const raw = async (p) => (await fetch(TWIN + p, { headers: { 'user-agent': UA } })).text()
const cardSlugs = (html) => [...html.matchAll(/class="mg_name">\s*<a[^>]*href="(?:https?:\/\/[^/"]+)?\/comic\/([^"/]+)"/g)].map((m) => m[1])
const labelsOf = (html) => [...html.matchAll(/href="(?:https?:\/\/[^/"]+)?\/manga-list\/([^"/]+)"[^>]*>([^<]+)</g)]
    .filter((m) => !['mature', 'hentai', 'uncensored', 'western', '3d'].includes(m[1]) || true)
    .map((m) => m[2].trim())

// The standing rules, restated plainly, to audit what the source lets through.
const MUST_NOT_SHOW = /yaoi|\bmales only\b|tomgirl|\btrap\b|crossdress|ugly bastard|\bbald\b|\bdilf\b|\bold man\b|\bmmf\b|mmm threesome|gangbang|gang rape|\borgy\b|reverse harem|tentacl|\bmonster\b|\balien\b|bestial|\bfurry\b|\bdog\b|\bhorse\b|^anime$|^game$/i

const expectGateThrow = async (label, fn, pattern = /will not be shown/i) => {
    try {
        await fn()
        check(label, false, 'opened instead of refusing')
    } catch (error) {
        check(label, pattern.test(error.message), error.message.slice(0, 90))
    }
}

;(async () => {
    const s = new Sources.Hentai3z()

    // ---- the parody rule, offline ----
    check('parody: a game title in brackets', Sources.parodyIn("Eula's Drunken Escapade (Genshin Impact)") != undefined)
    check('parody: a western comic names its parody before the artist', Sources.parodyIn('Triss Merigold (The Witcher) [PervertMuffinMajima]') != undefined)
    check('parody: a character name alone', Sources.parodyIn('Kijimuna plays with Astolfo ♥') != undefined)
    check('parody: an original with a subtitle in brackets is left alone', Sources.parodyIn('Chadou Yamato Nadeshiko NTR (Josei Shiten)') == undefined)
    check('parody: Tonari no Ayane-san is an original', Sources.parodyIn('Tonari no Ayane-san Ryokan de Shippori Hen') == undefined)
    check('parody: an event code is not a series', Sources.parodyIn('(C97) Some Original Book [Circle (Artist)]') == undefined)
    check('base64 pages decode', Sources.decodeBase64(Buffer.from('https://bk.18porncomic.com/uploads/manga/x/chapters/english/01.jpg').toString('base64'))
        === 'https://bk.18porncomic.com/uploads/manga/x/chapters/english/01.jpg')

    // ---- home sections ----
    const sections = []
    await s.getHomePageSections((sec) => sections.push(sec))
    check('home sections all carry items',
        sections.length === 3 && sections.every((x) => Array.isArray(x.items) && x.items.length > 0),
        sections.map((x) => `${x.title}:${x.items?.length}`).join(', '))
    check('tiles carry an id, https cover and a title',
        sections.every((sec) => sec.items.every((t) => t.mangaId.length > 0 && t.image.startsWith('https://') && t.title.length > 0)),
        JSON.stringify(sections[0].items[0]).slice(0, 120))

    // ---- everything shown opens, and carries nothing excluded ----
    const shown = sections.flatMap((sec) => sec.items).slice(0, 24)
    let opened = 0
    const leaks = []
    for (const tile of shown) {
        try {
            const details = await s.getMangaDetails(tile.mangaId)
            const chapters = await s.getChapters(tile.mangaId)
            if (chapters.length > 0) opened++
            const labels = (details.mangaInfo.tags?.[0]?.tags ?? []).map((t) => t.label)
            const bad = labels.filter((label) => MUST_NOT_SHOW.test(label))
            if (bad.length > 0) leaks.push(`${tile.title}: ${bad.join(', ')}`)
            if (labels.some((l) => /^group/i.test(l)) && (labels.some((l) => /sole female/i.test(l))
                || !labels.some((l) => /sole male|harem|ffm|mff/i.test(l)))) leaks.push(`${tile.title}: group without one man`)
        } catch (error) {
            leaks.push(`${tile.title}: ${error.message.slice(0, 60)}`)
        }
    }
    check('every shown tile opens with chapters', opened === shown.length, `${opened}/${shown.length}`)
    check('no shown tile carries an excluded tag or breaks the group rule', leaks.length === 0, leaks.slice(0, 4).join(' | ') || `${shown.length} audited`)

    // ---- the gate ----
    await expectGateThrow('gate: group with MMF and sole female refuses (Whole Cake Island Nami)', () => s.getMangaDetails('whole-cake-island-nami'))
    await expectGateThrow('gate: tomgirl refuses (Kijimuna plays with Astolfo)', () => s.getMangaDetails('kijimuna-plays-with-astolfo'))
    await expectGateThrow('gate: bald and DILF refuse (Dehya’s Babysitting Diary)', () => s.getMangaDetails('dehya-s-babysitting-diary'))
    const gameSlug = cardSlugs(await raw('/manga-list/game'))[0]
    await expectGateThrow(`gate: a title under "Game" refuses (${gameSlug})`, () => s.getMangaDetails(gameSlug), /parod/i)
    await expectGateThrow('gate: chapters refuse too', () => s.getChapters('whole-cake-island-nami'))
    await expectGateThrow('gate: pages refuse too', () => s.getChapterDetails('whole-cake-island-nami', 'whole-cake-island-nami/english'))

    // ---- the group rule against each page's own tags ----
    {
        let agreed = 0, allowed = 0, total = 0
        const disagreements = []
        for (const slug of cardSlugs(await raw('/manga-list/group')).slice(0, 12)) {
            const labels = labelsOf(await raw(`/comic/${slug}`))
            const standing = labels.some((l) => MUST_NOT_SHOW.test(l) || /fat|gigantic breasts|grandfather|bbm|mmt|mtf|ttf|ttm/i.test(l))
            const oneMan = labels.some((l) => /sole male|^harem$|ffm|mff/i.test(l)) && !labels.some((l) => /sole female|reverse harem/i.test(l))
            let opens = true
            try { await s.getMangaDetails(slug) } catch { opens = false }
            total++
            if (opens) allowed++
            const expected = !standing && oneMan && Sources.parodyIn(slug.replace(/-/g, ' ')) == undefined
            if (opens === expected || (!opens && expected)) agreed++
            else disagreements.push(`${slug}: opens=${opens} [${labels.slice(0, 6).join(', ')}]`)
        }
        check('group rule: nothing opens that the page shows several men or no one man in', disagreements.length === 0,
            disagreements.slice(0, 3).join(' | ') || `${total} group titles, ${allowed} allowed (one man, several women)`)
    }

    // ---- a manhwa, a doujin, and their pages ----
    {
        const chapters = await s.getChapters('boarding-diary-uncensored')
        // Its first chapters come in lettered parts, 1A and 1B: those have to
        // read in order and never share a number.
        check('manhwa: its own chapters, in order, each numbered once', chapters.length > 100
            && chapters.every((c, i) => i === 0 || c.chapNum > chapters[i - 1].chapNum)
            && chapters.every((c) => c.id.startsWith('boarding-diary-uncensored/')),
            `${chapters.length} chapters: ${chapters.slice(0, 4).map((c) => `${c.chapNum} ${c.id.split('/')[1]}`).join(', ')} … ${chapters[chapters.length - 1]?.chapNum}`)
        check('chapter numbers: lettered parts and plain chapters',
            Sources.chapterNumber('1-a', 'Chapter 1A') === 1.1 && Sources.chapterNumber('1-b', 'Chapter 1B') === 1.2
            && Sources.chapterNumber('chapter-108', 'Chapter 108') === 108 && isNaN(Sources.chapterNumber('english', 'English')))
        const pages = await s.getChapterDetails('boarding-diary-uncensored', 'boarding-diary-uncensored/chapter-108')
        check('manhwa: a chapter has its pages', pages.pages.length > 20 && pages.pages.every((p) => /^https:\/\/bk\.18porncomic\.com\//.test(p)),
            `${pages.pages.length} pages, ${pages.pages[0]}`)

        const doujin = await s.getChapters('guruguru-netachou-107')
        check('doujin: one chapter, named for the book', doujin.length === 1 && doujin[0].id === 'guruguru-netachou-107/english',
            doujin.map((c) => `${c.id} "${c.name}"`).join(' | '))
        const dpages = await s.getChapterDetails('guruguru-netachou-107', doujin[0].id)
        check('doujin: its pages', dpages.pages.length > 3, `${dpages.pages.length} pages`)
    }

    // ---- search and series merging ----
    {
        const found = await s.getSearchResults({ title: 'boarding diary', includedTags: [], excludedTags: [], parameters: {} }, undefined)
        const ids = found.results.map((t) => t.mangaId)
        // Two editions of one manhwa, censored and uncensored: one series, so
        // one tile -- the uncensored one.
        check('search: a manhwa\'s censored and uncensored editions are one tile, the uncensored',
            ids.includes('boarding-diary-uncensored') && !ids.includes('boarding-diary'), ids.join(', '))

        const series = await s.getSearchResults({ title: 'Netorarete Netorasete', includedTags: [], excludedTags: [], parameters: {} }, undefined)
        const tile = series.results.find((t) => t.mangaId.startsWith('s:'))
        check('series: numbered volumes come as one tile', tile != undefined && series.results.filter((t) => /netorarete netorasete/i.test(t.title)).length === 1,
            series.results.map((t) => t.mangaId).join(', '))
        if (tile != undefined) {
            const volumes = await s.getChapters(tile.mangaId)
            check('series: the tile opens with every volume, in order', volumes.length >= 2
                && volumes.every((c, i) => i === 0 || c.chapNum >= volumes[i - 1].chapNum),
                volumes.map((c) => `${c.chapNum}: ${c.name.slice(0, 30)}`).join(' | '))
        }
    }

    // ---- filters ----
    {
        const included = await s.getSearchResults({ title: '', includedTags: [{ id: 'vanilla', label: 'Vanilla' }], excludedTags: [], parameters: {} }, undefined)
        check('filter: an included tag browses it', included.results.length > 0, `${included.results.length} tiles`)

        const excluded = await s.getSearchResults({ title: '', includedTags: [{ id: 'vanilla', label: 'Vanilla' }], excludedTags: [{ id: 'big-breasts', label: 'Big Breasts' }], parameters: {} }, undefined)
        let carrying = 0
        for (const t of excluded.results.filter((x) => !x.mangaId.startsWith('s:')).slice(0, 8)) {
            const d = await s.getMangaDetails(t.mangaId)
            if ((d.mangaInfo.tags?.[0]?.tags ?? []).some((tag) => tag.id === 'big-breasts')) carrying++
        }
        check('filter: an excluded tag is left out', excluded.results.length > 0 && carrying === 0, `${excluded.results.length} tiles, ${carrying} carrying it`)
    }

    // ---- the offered catalog ----
    {
        const catalog = await s.getSearchTags()
        const labels = catalog.flatMap((section) => section.tags.map((t) => t.label))
        const sorted = labels.every((l, i) => i === 0 || labels[i - 1].localeCompare(l) <= 0)
        const banned = labels.filter((l) => /^(yaoi|males only|tomgirl|trap|crossdressing|anime|game|catboy|reverse harem|mmf threesome|ugly bastard|bald)$/i.test(l))
        check('catalog: offered alphabetically, nothing excluded on offer', labels.length > 100 && sorted && banned.length === 0,
            `${labels.length} tags${banned.length ? `, banned: ${banned.join(', ')}` : ''}`)
        check('catalog: the group rule\'s own tags stay offered', ['Group', 'Sole Male', 'Harem', 'FFM Threesome'].every((l) => labels.includes(l)))
        check('catalog: older-women tags stay offered', ['Old Lady', 'Grandmother'].every((l) => labels.includes(l)))
    }

    // ---- pagination ----
    {
        let meta
        const ids = []
        for (let i = 0; i < 3; i++) {
            const res = await s.getViewMoreItems('latest', meta)
            ids.push(...res.results.map((t) => t.mangaId))
            meta = res.metadata
            if (meta == undefined) break
        }
        check('pagination: three pages, no tile twice', ids.length > 10 && new Set(ids).size === ids.length, `${ids.length} tiles`)
    }

    note('requests used', String(requests))
    console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED', e.stack); process.exit(1) })
