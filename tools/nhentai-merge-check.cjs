/*
 * Checks nhentai's series merging and English-only rule.
 *
 * The offline half runs the shipped title splitter against real titles taken
 * from English NTR listings -- each one a gallery that used to show as its own
 * tile instead of joining its series -- plus titles that must NOT be read as
 * numbered, because a false volume number merges unrelated books.
 *
 * `--live` adds the two series the maintainer reported, opened through the
 * built source against the live API, and proves that a tag search returns no
 * Chinese galleries and that a Chinese gallery refuses to open. It paces
 * itself at 7.2s a request, under the API's ~10 a minute.
 */
const path = require('node:path')

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const LIVE = process.argv.includes('--live')
const GAP_MS = 7200

const identity = (x) => x
let last = 0
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ ...i }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request) => {
            if (!LIVE) throw new Error('offline run made a request')
            for (let attempt = 0; attempt < 3; attempt++) {
                const wait = Math.max(0, last + GAP_MS - Date.now())
                if (wait > 0) await new Promise((r) => setTimeout(r, wait))
                last = Date.now()
                const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
                const res = await fetch(req.url, { headers: { accept: 'application/json', ...(req.headers || {}) } })
                const data = await res.text()
                if (res.status === 429) { await new Promise((r) => setTimeout(r, 61000)); continue }
                return { data, status: res.status, headers: {}, request: req }
            }
            throw new Error('rate limited three times running')
        }
    })
}

const { Sources } = require(path.join(__dirname, '..', 'bundles', 'NHentai', 'source.js'))
const { splitTitle, seriesKey, sharesLead, sharesTail } = Sources

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

// [title, carries "multi-work series", expected base, expected volume]
const MERGES = [
    ['NTR Jigo Houkoku 2 After', false, 'NTR Jigo Houkoku', 2.5],
    ['Mesu no Ie III ~Oyako wa Midare Aisareru', false, 'Mesu no Ie', 3],
    ['Ryuumon ni Shimuru Ryuuge Zenpen', false, 'Ryuumon ni Shimuru Ryuuge', 1],
    ['Ryuumon ni Shimuru Ryuuge Kouhen', false, 'Ryuumon ni Shimuru Ryuuge', 2],
    ['Batsuichi Komochi Kouhen', false, 'Batsuichi Komochi', 2],
    ['Ichigun Joshi no Otoshikata "Zenpen" - Corrupting the Queen Bee', false, 'Ichigun Joshi no Otoshikata', 1],
    ['Marked-girls Vol.24 Takopi no Yobigoe', false, 'Marked-girls', 24],
    ['Marked girls vol. 22', false, 'Marked girls', 22],
    ['Netoria Marked-girls Origin Vol. 2', false, 'Netoria Marked-girls Origin', 2],
    ['Inmon Akuochi no Hime Kishidan Vol.2 Haiboku no Kyonyuu Jukujo', false, 'Inmon Akuochi no Hime Kishidan', 2],
    ['The Night She Trembled-The Reason Ichika Gave Her Body to a Scumbag Junior~ Part One', false, 'The Night She Trembled-The Reason Ichika Gave Her Body to a Scumbag Junior', 1],
    ['Soshite Kyou mo Moteasobareru 4 ~Yama Camp! Cosplay Hen', false, 'Soshite Kyou mo Moteasobareru', 4],
    ['Tsuma no Hajimete no Otoko 3 ~Kimeseku Choukyou Sareta Tsuma', false, 'Tsuma no Hajimete no Otoko', 3],
    ['Nearest to Real LOVE 7 “The Great Escape” Al~The Secret second season', false, 'Nearest to Real LOVE', 7],
    ['Aimai na Bokura 2 Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true, 'Aimai na Bokura', 2],
    ['Aimai na Bokura 3 Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true, 'Aimai na Bokura', 3],
    ['Breeding License: The Picking Up Girls on the Beach Edition', true, 'Breeding License', 1],
    ['WASANBON NAGI3', false, 'WASANBON NAGI', 3],
    ['Shouji Nigou Hanashi. Ch. 8', false, 'Shouji Nigou Hanashi', 8],
    ['Title Ch. 1-3', false, 'Title', 1]
]

for (const [title, series, base, volume] of MERGES) {
    const split = splitTitle(title, series)
    check(`"${title.slice(0, 48)}"${series ? ' (mws)' : ''}`,
        split.marked && split.base === base && split.volume === volume,
        `base "${split.base}", volume ${split.volume}, marked ${split.marked}`)
}

// A kanketsu (final) part sorts after everything; the source resolves it to
// "one past the last" once the other volumes are known.
const final = splitTitle('Piano Kyoushitsu no JS Kanojo x Swapping NTR Kanketsu-ban')
check('a Kanketsu-ban is read as the final part',
    final.marked && final.base === 'Piano Kyoushitsu no JS Kanojo x Swapping NTR' && final.volume > 1000,
    `base "${final.base}", volume ${final.volume}`)

// Titles that must stay single books. A mid-title number is only a volume
// when the site itself tags the gallery as part of a multi-work series.
const SINGLES = [
    'Aimai na Bokura 2 Kanojo wa Tabun, Korekara Mechakucha Sex Suru',
    'Futari no Oshigoto',
    'Uragiri Bedroom',
    'Soshite Kyou mo Cosplay Hen',
    '1DK Netorare',
    'Kanojo no Mama mo Sex Friend ni shita Hanashi!',
    'I Love My Sister',
    'Tokyo X Gal',
    'Summer Afterglow',
    'Counterpart Ecstasy',
    'Kasono Heya'
]
for (const title of SINGLES) {
    const split = splitTitle(title, false)
    check(`stays a single book: "${title.slice(0, 48)}"`, !split.marked, `base "${split.base}", volume ${split.volume}`)
}

check('"Marked-girls" and "Marked Girls" are one series key',
    seriesKey('Marked-girls') === seriesKey('Marked Girls'), `"${seriesKey('Marked-girls')}"`)

const TAILS = [
    ['NTR Jigo Houkoku', 'Toxic JK Netorare Jigo Houkoku', true],
    ['Netoria Marked-girls Origin', 'COSBITCH! Marked-girls Origin', true],
    ['Netoria Marked-girls Origin', 'Netoria 2 Marked Girls Origin', true],
    // The circle's other lines must stay apart from Origin.
    ['Netoria Marked-girls Origin', 'Marked-girls', false],
    ['Netoria Marked-girls Origin', 'Marked-girls Collection', false],
    // Shared words the genre itself is made of are not a series.
    ['Netorare Tsuma', 'Hitozuma Netorare Tsuma', false],
    ['Hitozuma no Himitsu', 'Kanojo no Himitsu', false]
]
for (const [a, b, expected] of TAILS) {
    check(`tail: "${a}" ~ "${b}" is ${expected}`, sharesTail(a, b) === expected)
}

const LEADS = [
    ['Aimai na Bokura', 'Aimai na Bokura Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true],
    ['Hitozuma no', 'Hitozuma no Himitsu', false],
    ['Netorare Tsuma', 'Netorare Tsuma no Himitsu', false]
]
for (const [a, b, expected] of LEADS) {
    check(`lead: "${a}" ~ "${b.slice(0, 30)}" is ${expected}`, sharesLead(a, b) === expected)
}

// Numbering spelt out, and page-range uploads, both from the NTR sample.
for (const [title, base, volume] of [
    ['Otonari no Moto Sakura-san Sono San', 'Otonari no Moto Sakura-san', 3],
    ['Tea Ceremony Yamato Nadeshiko NTR P01~08', 'Tea Ceremony Yamato Nadeshiko NTR', 1],
    ['Tea Ceremony Yamato Nadeshiko NTR P01~012', 'Tea Ceremony Yamato Nadeshiko NTR', 1]
]) {
    const split = splitTitle(title, false)
    check(`"${title}"`, split.marked && split.base === base && split.volume === volume,
        `base "${split.base}", volume ${split.volume}`)
}
check('stays a single book: "Ano Ko no Sono Saki"', !splitTitle('Ano Ko no Sono Saki', false).marked)

// ---- listing collapse, through the source's own tilesFrom ----
// One page of listing entries in, tiles out -- what the reader actually sees.
// Every entry carries the english language tag; 21572 marks the site's
// "multi-work series" tag.
const EN = 12227
const MWS = 21572
const tilesOf = (rows) => {
    const s = new Sources.NHentai()
    const entries = rows.map(([title, mws], index) => ({
        id: 900000 + index, english_title: title, thumbnail: '', tag_ids: mws ? [EN, MWS] : [EN]
    }))
    return s.tilesFrom(entries, new Set(), undefined)
}
const COLLAPSES = [
    ['one book uploaded twice, one upload tagged as a series',
        [['Ano Hi, Sunao ni Suki to Ieta nara - If only I could have honestly said that I loved you that day', true],
            ['Ano Hi, Sunao ni Suki to Ieta nara - If only I could have honestly said that I loved you that day', false]], 1],
    ['a series-cut name absorbs the same book untagged',
        [['Ano Hi, Sunao ni Suki to Ieta nara - If only I could have honestly said that I loved you that day', true],
            ['Ano Hi, Sunao ni Suki to Ieta nara - If only I could', false]], 1],
    ['one book with and without its English subtitle',
        [['Boku no Mizugi ga Kakusarete', false], ['Boku no Mizugi ga Kakusarete - My Swimsuit Got Stolen', false]], 1],
    ['an unnumbered opener joins its numbered volumes',
        [['Aimai na Bokura Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true],
            ['Aimai na Bokura 2 Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true],
            ['Aimai na Bokura 3 Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true]], 1],
    ['page ranges of one upload in progress',
        [['Tea Ceremony Yamato Nadeshiko NTR', false], ['Tea Ceremony Yamato Nadeshiko NTR P01~08', false],
            ['Tea Ceremony Yamato Nadeshiko NTR P01~012', false]], 1],
    // Must stay apart.
    ['two different books sharing a lead', [['Hitozuma Kyoushi', false], ['Hitozuma Kyoushi no Himitsu', false]], 2],
    ['a numbered sub-line beside the main line', [['Marked-girls Vol. 5', false], ['Marked-girls Collection Vol. 3', false]], 2]
]
for (const [label, rows, expected] of COLLAPSES) {
    const tiles = tilesOf(rows)
    check(`listing: ${label} -> ${expected} tile(s)`, tiles.length === expected,
        tiles.map((t) => `${t.mangaId.slice(0, 40)}`).join(' | '))
}

// ---- one series, every volume leading with a title of its own ----
// The maintainer's report: searching "Marked-girls Origin" showed four Origin
// tiles and "Jigo Houkoku" two. These are the real raw titles, credits and all,
// because the credit is what tells the listing they are one creator's series.
check('creatorOf reads the credit past an event prefix',
    Sources.creatorOf('(SC2018 Autumn) [Marked-two (Suga Hideo)] Netoria Marked-girls Origin Vol. 2 [English]') === 'marked two suga hideo'
        && Sources.creatorOf('[Marked-Two (Suga Hideo)] Marked-girls Origin Vol. 11') === 'marked two suga hideo',
    Sources.creatorOf('(SC2018 Autumn) [Marked-two (Suga Hideo)] Netoria Marked-girls Origin Vol. 2 [English]'))
const SAME_CREATOR = [
    ['the Origin volumes, each under its own title',
        [['(SC2018 Autumn) [Marked-two (Suga Hideo)] Netoria Marked-girls Origin Vol. 2 [English] [ScanMTL]', false],
            ['(C97) [Marked-two (Suga Hideo)] pa:Costa Del Sol Marked girls Origin Vol. 4 [English] [ScanMTL]', false],
            ['[Marked-Two (Suga Hideo)] Hi.Mi.Tsu.Ma Marked-girls Origin Vol. 5 [English]', false],
            ['[Marked-two (Suga Hideo)] Netori Esthe Marked-girls Origin Vol. 7 [English]', false]], 1],
    ['NTR Jigo Houkoku and its differently titled first book',
        [['[Mint no Chicchai Oana (Mint Muzzlini)] Toxic JK Netorare Jigo Houkoku... [English] [Solid Rose]', false],
            ['[Mint no Chicchai Oana (Mint Muzzlini)] NTR Jigo Houkoku 2 After [English]', true]], 1],
    // Arcs named "… Hen" that continue the series name, from the broad English
    // sample -- the site tags only some of them as a multi-work series, so the
    // shared credit and the shared start are what tie them.
    ['a series and its "Hen" arcs, the series name first',
        [['[Arakure (Arakure)] Tonari no Ayane-san [English]', true],
            ['[Arakure (Arakure)] Tonari no Ayane-san Desaki Battari Hen [English]', true],
            ['[Arakure (Arakure)] Tonari no Ayane-san Itazura Jidori to Oshioki Ecchi Hen [English]', true]], 1],
    ['a series and its "Hen" arc, the arc first on the page',
        [['[Arakure (Arakure)] Tonari no Ayane-san Desaki Battari Hen [English]', true],
            ['[Arakure (Arakure)] Tonari no Ayane-san [English]', true]], 1],
    ['an untagged first book and its tagged arc',
        [['[Hiroyuki (Hiroyuki)] Mukuchi na Tosho Iin to Sex Zuke [English]', false],
            ['[Hiroyuki (Hiroyuki)] Mukuchi na Tosho Iin to Sex Zuke. Natsuyasumi Hen ~Sex zuke no Natsuyasumi~ [English]', true]], 1],
    // Must stay apart.
    ['the circle\'s main, Origin and Collection lines',
        [['[Marked-two (Suga Hideo)] Marked-girls Vol. 5 [English]', false],
            ['[Marked-two (Suga Hideo)] Netoria Marked-girls Origin Vol. 2 [English]', false],
            ['[Marked-two (Suga Hideo)] Marked-girls Collection Vol. 3 [English]', false]], 3],
    ['different creators whose titles end alike',
        [['[Circle A (Artist A)] Hitozuma Choukyou Nikki [English]', false], ['[Circle B (Artist B)] Imouto Choukyou Nikki [English]', false]], 2]
]
for (const [label, rows, expected] of SAME_CREATOR) {
    const tiles = tilesOf(rows)
    check(`listing: ${label} -> ${expected} tile(s)`, tiles.length === expected,
        tiles.map((t) => `${t.mangaId.slice(0, 44)}`).join(' | '))
    // A merged tile has to open as a series; a bare gallery id opens as one book.
    if (expected === 1) {
        check(`listing: ${label} opens as a series`, tiles[0]?.mangaId.startsWith('s:') === true, tiles[0]?.mangaId)
    }
}

// The same, with the pair a page apart -- the way the app actually scrolls,
// carrying one `seen` set from page to page.
const tilesAcross = (pages) => {
    const s = new Sources.NHentai()
    const seen = new Set()
    const tiles = []
    let next = 910000
    for (const rows of pages) {
        const entries = rows.map(([title, mws]) => ({ id: next++, english_title: title, thumbnail: '', tag_ids: mws ? [EN, MWS] : [EN] }))
        tiles.push(...s.tilesFrom(entries, seen, undefined))
    }
    return tiles
}
const ACROSS = [
    ['one book a page apart from its subtitled upload',
        [[['Boku no Mizugi ga Kakusarete', false]], [['Boku no Mizugi ga Kakusarete - My Swimsuit Got Stolen', false]]], 1],
    ['an opener a page before its numbered volume',
        [[['Aimai na Bokura Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true]], [['Aimai na Bokura 2 Kanojo wa Tabun, Korekara Mechakucha Sex Suru', true]]], 1],
    ['two different books a page apart', [[['Hitozuma Kyoushi', false]], [['Hitozuma Kyoushi no Himitsu', false]]], 2],
    ['a numbered sub-line a page after the main line', [[['Marked-girls Vol. 5', false]], [['Marked-girls Collection Vol. 3', false]]], 2],
    // Same creator, same ending, a page apart. With the series tile first, the
    // later first book folds into it. The other way round it cannot: the first
    // book is already on screen as a single book by the time its series turns
    // up, and a tile cannot be taken back -- so the series tile still appears,
    // since it is the one that opens every volume.
    ['a series tile, then its differently titled first book a page later',
        [[['[Mint no Chicchai Oana (Mint Muzzlini)] NTR Jigo Houkoku 2 After [English]', true]],
            [['[Mint no Chicchai Oana (Mint Muzzlini)] Toxic JK Netorare Jigo Houkoku... [English]', false]]], 1],
    ['a first book, then its series tile a page later',
        [[['[Mint no Chicchai Oana (Mint Muzzlini)] Toxic JK Netorare Jigo Houkoku... [English]', false]],
            [['[Mint no Chicchai Oana (Mint Muzzlini)] NTR Jigo Houkoku 2 After [English]', true]]], 2],
    ['Origin volumes a page apart',
        [[['(SC2018 Autumn) [Marked-two (Suga Hideo)] Netoria Marked-girls Origin Vol. 2 [English]', false]],
            [['(C97) [Marked-two (Suga Hideo)] pa:Costa Del Sol Marked girls Origin Vol. 4 [English]', false]]], 1],
    // A series name, then its arc a page later: the arc folds in.
    ['a series name, then its "Hen" arc a page later',
        [[['[Arakure (Arakure)] Tonari no Ayane-san [English]', true]],
            [['[Arakure (Arakure)] Tonari no Ayane-san Desaki Battari Hen [English]', true]]], 1],
    // The arc first: the series name a page later folds into the arc's tile,
    // which is already a series and opens with both.
    ['a "Hen" arc, then its series name a page later',
        [[['[Arakure (Arakure)] Tonari no Ayane-san Desaki Battari Hen [English]', true]],
            [['[Arakure (Arakure)] Tonari no Ayane-san [English]', true]]], 1],
    // A single book first, then a numbered series its name continues: the
    // series must still appear. Skipping it behind the book's tile, as the
    // listing once did, lost the series altogether.
    ['a single book, then the numbered series it opens a page later',
        [[['[Arakure (Arakure)] Tonari no Ayane-san Desaki Battari Hen [English]', false]],
            [['[Arakure (Arakure)] Tonari no Ayane-san 2 [English]', false]]], 2]
]
for (const [label, pages, expected] of ACROSS) {
    const tiles = tilesAcross(pages)
    check(`listing across pages: ${label} -> ${expected} tile(s)`, tiles.length === expected,
        tiles.map((t) => t.mangaId.slice(0, 40)).join(' | '))
}

// ---- series assembly, through the source's own getChapters ----
// The API is stood in for by canned listing entries, so the decisions that
// build a series can be checked without a request: the name search answers
// with what a quoted phrase would match, the artist search with the artist's
// whole catalogue. The titles are the real Aimai na Bokura volumes.
const GROUP = 8010 // the banned "group" tag, which the real opener carries
const fakeSeries = (byName, byArtist) => {
    const s = new Sources.NHentai()
    s.parodyIds = async () => new Set()
    s.gallery = async () => ({ tags: [{ id: 1, type: 'artist', name: 'tsukuyomi' }] })
    s.fetchJson = async (url) => ({ result: decodeURIComponent(url).includes('artist:') ? byArtist : byName })
    return s
}
const listed = (id, title, tags) => ({ id: id, english_title: title, thumbnail: '', tag_ids: tags })
const OPENER_TITLE = 'Aimai na Bokura Kanojo wa Tabun, Korekara Mechakucha Sex Suru'
const OPENER = listed(1, OPENER_TITLE, [EN, MWS])
const VOL2 = listed(2, 'Aimai na Bokura 2 Kanojo wa Tabun, Korekara Mechakucha Sex Suru', [EN, MWS])
const VOL3 = listed(3, 'Aimai na Bokura 3 Kanojo wa Tabun, Korekara Mechakucha Sex Suru', [EN, MWS])
const UNRELATED = listed(4, 'Tsuma to Musume no Himitsu', [EN])

const idsOf = (chapters) => chapters.map((c) => c.id).join(',')
const refusal = async (label, run, pattern) => {
    try {
        const chapters = await run()
        check(label, false, `opened with ${chapters.length} chapter(s)`)
    } catch (error) {
        check(label, pattern.test(error.message), error.message.slice(0, 90))
    }
}

const seriesOffline = async () => {
    // Its own name search finds only itself -- the "2" breaks the phrase --
    // so the numbered volumes arrive through the artist search.
    const fromOpener = await fakeSeries([OPENER], [OPENER, VOL2, VOL3, UNRELATED]).getChapters(`s:${OPENER_TITLE}`)
    check('series: an unnumbered opener gathers the numbered volumes after it',
        idsOf(fromOpener) === '1,2,3', fromOpener.map((c) => `${c.chapNum}:${c.id}`).join(' '))

    const fromNumbered = await fakeSeries([OPENER, VOL2, VOL3], [UNRELATED]).getChapters('s:Aimai na Bokura')
    check('series: a numbered series gathers its unnumbered opener',
        idsOf(fromNumbered) === '1,2,3', fromNumbered.map((c) => `${c.chapNum}:${c.id}`).join(' '))

    const withoutOpener = await fakeSeries([listed(1, OPENER_TITLE, [EN, MWS, GROUP]), VOL2, VOL3], []).getChapters('s:Aimai na Bokura')
    check('series: an excluded volume is left out and the rest stay',
        idsOf(withoutOpener) === '2,3', idsOf(withoutOpener))

    await refusal('series: a series whose every volume is excluded says so, not "no volumes found"',
        () => fakeSeries([listed(1, OPENER_TITLE, [EN, MWS, GROUP])], []).getChapters(`s:${OPENER_TITLE}`),
        /left out by your settings/i)
    await refusal('series: a series with nothing in English says so',
        () => fakeSeries([], []).getChapters('s:Nothing Like This Exists'),
        /English galleries only/i)

    // A tile opens with everything the listing folded into it, even volumes
    // the artist search cannot reach -- it reads one page, and Marked-two's
    // older Origin volumes are past it. The failure this guards against: the
    // listing folded Hi.Mi.Tsu.Ma and Netori Esthe into the Origin tile, and
    // opening the tile showed neither, so they had simply vanished.
    const ORIGIN_2 = listed(11, '(SC2018 Autumn) [Marked-two (Suga Hideo)] Netoria Marked-girls Origin Vol. 2 [English]', [EN])
    const ORIGIN_5 = listed(13, '[Marked-Two (Suga Hideo)] Hi.Mi.Tsu.Ma Marked-girls Origin Vol. 5 [English]', [EN])
    const ORIGIN_7 = listed(14, '[Marked-two (Suga Hideo)] Netori Esthe Marked-girls Origin Vol. 7 [English]', [EN])
    const lister = fakeSeries([ORIGIN_2], [])
    const [originTile] = lister.tilesFrom([ORIGIN_2, ORIGIN_5], new Set(), undefined)
    const originSeen = new Set()
    lister.tilesFrom([ORIGIN_2, ORIGIN_5], originSeen, undefined)
    lister.tilesFrom([ORIGIN_7], originSeen, undefined)
    const opened = await lister.getChapters(originTile.mangaId)
    check('series: a tile opens with every volume the listing folded into it, on one page or across pages',
        idsOf(opened) === '11,13,14', `${originTile.mangaId} -> ${opened.map((c) => `${c.chapNum}:${c.id}`).join(' ')}`)

    // A series and its "Hen" arcs. Opened by the series name, its own name
    // search finds every arc, since each arc's name continues it.
    const AYANE = listed(21, '[Arakure (Arakure)] Tonari no Ayane-san [English]', [EN, MWS])
    const ARC_1 = listed(22, '[Arakure (Arakure)] Tonari no Ayane-san Desaki Battari Hen [English]', [EN, MWS])
    const ARC_2 = listed(23, '[Arakure (Arakure)] Tonari no Ayane-san Itazura Jidori to Oshioki Ecchi Hen [English]', [EN, MWS])
    const bySeries = await fakeSeries([AYANE, ARC_1, ARC_2], []).getChapters('s:Tonari no Ayane-san')
    check('series: a series name gathers the "Hen" arcs that continue it', idsOf(bySeries) === '21,22,23', idsOf(bySeries))

    // Opened by an arc's own long name -- an arc shown alone, or bookmarked --
    // it has to reach back to the series name it continues. Its name search
    // cannot find that (the shorter title does not contain the longer), so it
    // comes from the artist's catalogue.
    const byArc = await fakeSeries([ARC_1], [AYANE, ARC_1]).getChapters('s:Tonari no Ayane-san Desaki Battari Hen')
    check('series: an arc opened on its own name reaches back to its series', idsOf(byArc) === '21,22', idsOf(byArc))

    // …but not to a numbered line of its own that happens to share the start.
    const MAIN_5 = listed(31, '[Marked-two (Suga Hideo)] Marked-girls Vol. 5 [English]', [EN])
    const COLLECTION_3 = listed(32, '[Marked-two (Suga Hideo)] Marked-girls Collection Vol. 3 [English]', [EN])
    const byMain = await fakeSeries([MAIN_5], [MAIN_5, COLLECTION_3]).getChapters('s:Marked-girls')
    check('series: a numbered sub-line is not pulled into the main line', idsOf(byMain) === '31', idsOf(byMain))

    // A series' untagged first book shown alone a page before the series: the
    // book's tile cannot become the series, so the series tile appears after
    // it -- and must open with that first book, even when neither its own name
    // search nor the artist search returns it.
    const TOXIC = listed(41, '[Mint no Chicchai Oana (Mint Muzzlini)] Toxic JK Netorare Jigo Houkoku... [English]', [EN])
    const JIGO_2 = listed(42, '[Mint no Chicchai Oana (Mint Muzzlini)] NTR Jigo Houkoku 2 After [English]', [EN, MWS])
    const jigoLister = fakeSeries([JIGO_2], [])
    const jigoSeen = new Set()
    jigoLister.tilesFrom([TOXIC], jigoSeen, undefined)
    const [jigoTile] = jigoLister.tilesFrom([JIGO_2], jigoSeen, undefined)
    const jigoOpened = jigoTile ? await jigoLister.getChapters(jigoTile.mangaId) : []
    check('series: a series tile shown after its first book opens with that book',
        idsOf(jigoOpened) === '41,42', `${jigoTile?.mangaId} -> ${jigoOpened.map((c) => `${c.chapNum}:${c.id}`).join(' ')}`)

    // An arc shown a page before its series name: the name folds into the arc's
    // tile, and the tile opens with both.
    const arcLister = fakeSeries([ARC_1], [])
    const arcSeen = new Set()
    const [arcTile] = arcLister.tilesFrom([ARC_1], arcSeen, undefined)
    const afterArc = arcLister.tilesFrom([AYANE], arcSeen, undefined)
    const arcOpened = await arcLister.getChapters(arcTile.mangaId)
    check('series: a series name a page after its arc folds into the arc\'s tile, which opens with both',
        afterArc.length === 0 && idsOf(arcOpened) === '21,22',
        `${afterArc.length} new tile(s); ${arcTile.mangaId} -> ${idsOf(arcOpened)}`)

    // The sequence the broad English sample actually had: one arc, then the
    // series name, then a second arc, a page apart each. The tile is named for
    // the first arc; the second arc shares nothing with that name but "Hen",
    // so it can only find the tile through the series name the tile took in.
    const chainLister = fakeSeries([ARC_2], [])
    const chainSeen = new Set()
    const [chainTile] = chainLister.tilesFrom([ARC_2], chainSeen, undefined)
    const chainLater = [
        ...chainLister.tilesFrom([AYANE], chainSeen, undefined),
        ...chainLister.tilesFrom([ARC_1], chainSeen, undefined)
    ]
    const chainOpened = await chainLister.getChapters(chainTile.mangaId)
    check('series: an arc, its series name and a second arc, a page apart each, are one tile that opens with all three',
        chainLater.length === 0 && idsOf(chainOpened) === '21,22,23',
        `${chainLater.length} later tile(s) ${chainLater.map((t) => t.mangaId).join(' | ')}; ${chainTile.mangaId} -> ${idsOf(chainOpened)}`)
}

if (!LIVE) {
    seriesOffline().then(() => {
        console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall offline checks passed (run with --live for the API checks)')
        process.exit(failures > 0 ? 1 : 0)
    }).catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
}

;(async () => {
    if (!LIVE) return
    await seriesOffline()
    const s = new Sources.NHentai()

    // ---- the two series the maintainer reported ----
    const jigo = await s.getChapters('s:NTR Jigo Houkoku')
    const jigoIds = jigo.map((c) => c.id)
    check('NTR Jigo Houkoku gathers the sequel and the differently titled first book',
        jigoIds.includes('668720') && jigoIds.includes('510240'),
        jigo.map((c) => `${c.chapNum}: ${c.name.slice(0, 40)}`).join(' | '))

    // Of the Origin volumes in English, 1 is a Kantai Collection parody, 9 is
    // tagged "group" and 11 "dilf" and "bbm" -- all three excluded by standing
    // rules, so 2 ("Netoria …") and 4 ("pa:Costa Del Sol …") are the series as
    // this reader is allowed it. That they arrive together is the proof: they
    // share no leading words, only the artist and "Marked-girls Origin".
    const origin = await s.getChapters('s:Netoria Marked-girls Origin')
    const originNames = origin.map((c) => c.name)
    const originIds = origin.map((c) => c.id)
    check('Netoria Marked-girls Origin gathers a differently titled Origin volume',
        originIds.includes('673701') && originIds.includes('673702'),
        origin.map((c) => `${c.chapNum}: ${c.name.slice(0, 40)}`).join(' | '))
    check('…and none of the Origin volumes the standing rules exclude',
        !originIds.some((id) => ['673700', '673703', '673705', '534191'].includes(id)),
        originIds.join(', '))
    check('…and leaves the circle\'s main and Collection lines out',
        !originNames.some((n) => !/origin/i.test(n) || /collection/i.test(n)),
        originNames.filter((n) => !/origin/i.test(n) || /collection/i.test(n)).join(' | ') || 'none leaked')
    check('…with no volume listed twice',
        new Set(origin.map((c) => c.chapNum)).size === origin.length,
        origin.map((c) => c.chapNum).join(', '))

    // The real Aimai na Bokura opener, 678855, carries the banned "group" tag,
    // so the opener-gathers-its-volumes path is proven offline above, against
    // canned entries. What is proven here is the live consequence: the series
    // never gains that volume, and opening the opener's own entry -- say an old
    // library bookmark -- refuses in words, not with "No volumes found".
    try {
        const aimai = await s.getChapters('s:Aimai na Bokura')
        check('Aimai na Bokura never gains its excluded opener', !aimai.some((c) => c.id === '678855'),
            aimai.map((c) => `${c.chapNum}: ${c.id}`).join(' | '))
    } catch (error) {
        check('Aimai na Bokura, if wholly excluded, says why', /left out by your settings/i.test(error.message), error.message.slice(0, 90))
    }
    // Every search already negates the excluded tags, so the site never hands
    // the opener back to be refused, and the source cannot tell "excluded"
    // from "not in English" without spending a request on it. Either message
    // names the rules at work; what must never come back is the bare "No
    // volumes found" that reads as a fault.
    try {
        await s.getChapters('s:Aimai na Bokura Kanojo wa Tabun, Korekara Mechakucha Sex Suru')
        check('the excluded opener\'s own entry refuses to open', false, 'it opened')
    } catch (error) {
        check('the excluded opener\'s own entry refuses to open, and says why',
            /left out by your settings|leaves out anything your settings exclude/i.test(error.message), error.message.slice(0, 90))
    }

    // ---- English only ----
    const raw = await (await fetch('https://nhentai.net/api/v2/search?query=' + encodeURIComponent('tag:netorare language:chinese') + '&sort=date&page=1',
        { headers: { 'user-agent': UA } })).json()
    const chineseIds = (raw.result ?? []).map((g) => String(g.id))
    await new Promise((r) => setTimeout(r, GAP_MS))

    const ntr = await s.getSearchResults({ title: '', includedTags: [{ id: 'tag:netorare' }], excludedTags: [], parameters: {} }, undefined)
    const leaked = ntr.results.map((r) => r.mangaId).filter((id) => chineseIds.includes(id))
    check('a netorare tag search returns no Chinese galleries',
        ntr.results.length > 0 && leaked.length === 0,
        `${ntr.results.length} tiles against ${chineseIds.length} known Chinese galleries, ${leaked.length} leaked`)

    const typed = await s.getSearchResults({ title: 'ntr', includedTags: [], excludedTags: [], parameters: {} }, undefined)
    const typedLeak = typed.results.map((r) => r.mangaId).filter((id) => chineseIds.includes(id))
    check('a typed "ntr" search returns no Chinese galleries', typed.results.length > 0 && typedLeak.length === 0,
        `${typed.results.length} tiles, ${typedLeak.length} leaked`)

    if (chineseIds.length > 0) {
        try {
            await s.getMangaDetails(chineseIds[0])
            check(`a Chinese gallery refuses to open (${chineseIds[0]})`, false, 'it opened')
        } catch (error) {
            check(`a Chinese gallery refuses to open (${chineseIds[0]})`, /not in English/i.test(error.message), error.message.slice(0, 70))
        }
    }

    console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed')
    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
