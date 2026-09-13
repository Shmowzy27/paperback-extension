import {
    BadgeColor,
    Chapter,
    ChapterDetails,
    ChapterProviding,
    CloudflareBypassRequestProviding,
    ContentRating,
    HomePageSectionsProviding,
    HomeSection,
    HomeSectionType,
    MangaProviding,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    SearchResultsProviding,
    SourceInfo,
    SourceIntents,
    SourceManga,
    Tag,
    TagSection
} from '@paperback/types'

import * as cheerio from 'cheerio'
import { CheerioAPI } from 'cheerio'

export const ASM_DOMAIN = 'https://asmhentai.com'

/**
 * Excluded by standing request: no BL/yaoi/male-to-male content, no ugly
 * bastard, bald, tomgirl or crossdressing.
 *
 * Listing cards annotate themselves with numeric tag ids
 * (`data-tags="9 61 3227"`), so the ids do the filtering before anything is
 * shown. Each was resolved from the site's own data -- the id carried by every
 * card on that tag's listing. `fat` and `shounen-ai` are not tags here at all,
 * and `ugly bastard` has too few galleries to resolve that way, so the label
 * gate on the details page covers those.
 */
/**
 * Every banned tag's numeric id, resolved from the site's own listings -- the
 * id carried by every card under that tag.
 *
 * The list has to be this complete. Cards annotate themselves with ids only,
 * so a name the gate refuses but the card filter does not know is a gallery
 * that shows in a listing and then errors when opened. That is exactly what
 * happened when the names grew and this set stayed at five.
 *
 * `32` (males only) is absent on purpose: the site has no such tag, and the
 * name matched "females only" until the pattern below was anchored.
 */
const BANNED_TAG_IDS = new Set([
    '13', '24', '84', '87', '88', '102', '104', '105', '106',
    '117', '118', '122', '143', '151', '178', '215', '218', '270', '297',
    '302', '309', '311', '339', '343', '344', '353', '369', '371', '376',
    '377', '379', '380', '398', '405', '406', '417', '418', '441', '442',
    '445', '454', '460', '493', '534', '548', '560', '563', '581', '660',
    '1153', '1225', '1296', '1469', '1580', '3513', '4021', '5478', '7381', '8220', '8224'
])

/**
 * The same rule by name, for a gallery's own tags and the offered catalog.
 *
 * `\bmales only\b` is anchored because "females only" contains it -- that one
 * missing boundary was excluding female-only galleries, the opposite of what
 * the rule is for.
 *
 * The threesome codes read as: two or more male-bodied participants, m or t,
 * so mmf, mmm, mmt, mtf, ttf and ttm go while ffm and fff stay.
 */
const BANNED_LABELS = /yaoi|boys?.?love|shounen[ -]?ai|\bmales only\b|tomgirl|crossdress|ugly bastard|\bbald\b|\bfat\b|gigantic breasts|\bold\s*m[ae]n\b|\bolder\s*m[ae]n\b|\bold\s*guy\b|\bgrandfather\b|\bgrandpa\b|\bgrand-?dad\b|\bgramps\b|\bdilf\b|reverse[- ]?harem|\bbbm\b|\bgang|\borgy\b|\b[mt]{2,}[mtf]\s*(?:threesome|foursome)\b|\bmm+f?\b|bestial|\bfurry\b|animal on|human on furry|octopus|\btentacl|\bmonster|\bslime\b|\binsect|\bsnake\b|\bspider\b|\bworm\b|\bcentaur\b|\bminotaur\b|\bhorse\b|\bdog\b|\bcat\b(?!\s*ears)|\bpig\b|\bfish\b|\bfrog\b|\bbird (?:girl|boy)\b|\bbear\b|\bwolf\b|\balien\b/i

/**
 * Anime and game parodies are excluded, leaving original works. The site marks
 * the latter with its own "original" parody, id 2721, so a gallery is refused
 * when it carries any parody other than that one. Nine of twenty English
 * galleries carry no parody at all, and those are unaffected.
 */
const ORIGINAL_PARODY_ID = '2721'

/**
 * A tag carried by only a handful of galleries is not a genre, it is noise --
 * a misspelling, an artist's name that landed in the tag table, or a one-off.
 * They filled the alphabetical catalog with entries like ".labo" that no other
 * site carries, so the offer stops at tags with a real body of work behind
 * them.
 */
const MIN_CATALOG_GALLERIES = 50

/**
 * Language ids, deduced from the site's own language listings: every card on
 * /language/english/ carries 1, /language/japanese/ carries 2 and
 * /language/chinese/ carries 3. 4 marks a translation.
 *
 * English only, by request -- no Chinese or Japanese-original galleries.
 */
const ENGLISH_LANGUAGE_ID = '1'

/** Card annotations, by the attribute that carries them. */
const ANNOTATION_TYPES: [string, string][] = [
    ['data-tags', 'tag'],
    ['data-artists', 'artist'],
    ['data-parodies', 'parody'],
    ['data-characters', 'character'],
    ['data-groups', 'group'],
    ['data-categories', 'category']
]

const SECTIONS: { id: string; label: string; path: string }[] = [
    { id: 'latest', label: 'Latest (English)', path: '/language/english/' },
    { id: 'popular', label: 'Most Popular (English)', path: '/language/english/popular/' }
]

/**
 * Browsable catalogs. The bare index of each type lists only the hundred-odd
 * most popular, which left most of the site's 8,232 tags unreachable, so tags
 * are gathered a letter at a time instead -- `/tags/a/` and so on, plus a
 * `num` bucket for the ones that start with a digit.
 *
 * Only tags are gathered that thoroughly. Parodies are not offered at all: the
 * catalog ran to 2,470 entries and cost half the requests of the whole filter
 * screen, for a list nobody filters by. Artists stay on their popular index --
 * there are 30,827 of them, which is neither quick to gather nor useful as a
 * list. Both still appear on a gallery's own details page.
 */
const TAG_TYPES: { type: string; path: string; label: string; byLetter: boolean }[] = [
    { type: 'tag', path: '/tags/', label: 'Tags', byLetter: true },
    { type: 'artist', path: '/artists/', label: 'Artists', byLetter: false }
]

const CATALOG_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('').concat(['num'])

/**
 * Galleries here are flat -- a multi-volume work is published as several
 * separate galleries -- so volumes are merged into one library entry. The
 * rules that read a series off a title, the fold that turns a listing into one
 * tile per series, and the rules for gathering a series are the nhentai
 * source's: they live in ../NHentai/SeriesMerge.ts and are shared, so a fix
 * lands in both at once. This source kept its own copy once, and it fell
 * behind -- no creator rule, no multi-work tag, one search page.
 */
import {
    cleanTitle,
    creatorsOf,
    FoldItem,
    FoldMemo,
    foldedInto,
    foldTiles,
    isLongName,
    nothingToShow,
    orderVolumes,
    SERIES_PREFIX,
    seriesKey,
    splitTitle,
    volumeOf
} from '../NHentai/SeriesMerge'
import { GROUP_REFUSAL_MESSAGE, groupRefusal, groupRefusedByIds } from '../NHentai/ContentRules'
export { cleanTitle, splitTitle } from '../NHentai/SeriesMerge'

/**
 * The site's own "multi-work series" tag: id 25, carried by every card on
 * /tag/multi-work-series/. Its word that a gallery has siblings.
 */
const MULTI_WORK_TAG_ID = '25'

/**
 * The group rule (../NHentai/ContentRules.ts) in this site's tag ids, each
 * resolved as the id on every card of the tag's own listing that is rarest
 * site-wide: group 8; sole male 97, ffm threesome 38, harem 54; sole female
 * 96. ("Every card" alone is not enough here: id 1 is on every card of the
 * mmf-threesome listing, and on over half of all English cards besides.)
 */
const GROUP_RULE = { group: ['8'], oneMale: ['97', '38', '54'], oneFemale: ['96'] }

/** A card's artist and group, as the ids its own attributes carry. */
const creditIdsOf = (card: { attr: (name: string) => string | undefined }): string[] => {
    const ids: string[] = []
    for (const [attribute, type] of [['data-artists', 'artist'], ['data-groups', 'group']] as [string, string][]) {
        for (const id of (card.attr(attribute) ?? '').split(/\s+/)) {
            if (id.length > 0) ids.push(`${type}:${id}`)
        }
    }
    return ids
}

export const isSeriesId = (mangaId: string): boolean => mangaId.startsWith(SERIES_PREFIX)
export const baseFromSeriesId = (mangaId: string): string => mangaId.slice(SERIES_PREFIX.length)

interface ListingMetadata {
    page?: number
    seen?: string[]
}

interface CardRow {
    galleryId: string
    /** The caption as the site gives it, credits and all. */
    raw: string
    /** Tagged by the site as part of a multi-work series. */
    multiWork: boolean
    /** Its artist and group ids, and every name those are known by. */
    creators: string[]
    base: string
    title: string
    volume: number
    marked: boolean
    thumb: string
    /**
     * The card's own annotations, each prefixed with its type -- "tag:13",
     * "artist:8986". The site's search has no minus operator and a tag listing
     * cannot be narrowed by a second tag, so a reader's chosen filters are
     * applied against these.
     */
    annotations: string[]
}

/**
 * asmhentai.com, English-only and filtered.
 *
 * Chosen as a faster companion to the nhentai source rather than a
 * replacement: measured against twenty recent nhentai titles it carries about
 * two thirds of them, but it answers sixty requests a minute without
 * complaint where nhentai's API allows about ten, so browsing it is immediate.
 *
 * Excluded by construction: the standing BL/yaoi rule plus ugly bastard, bald,
 * tomgirl and crossdressing, dropped from listings on the cards' own tag ids
 * and refused again on the details page by label. Galleries that are not
 * English are dropped the same way, on the cards' language ids.
 */
export const AsmHentaiInfo: SourceInfo = {
    version: '1.6.3',
    name: 'AsmHentai (English)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls English galleries from asmhentai.com with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: ASM_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class AsmHentai implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        // Measured: eighteen consecutive gallery pages at one a second drew no
        // rate limiting at all, so this stays brisk. The generous timeout is
        // the lesson from the sibling sources, where a tight ceiling turned
        // slow-but-fine responses into refresh failures.
        requestsPerSecond: 2,
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${ASM_DOMAIN}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    /** A merged series has no page of its own, so sharing one points at search. */
    getMangaShareUrl(mangaId: string): string {
        return isSeriesId(mangaId)
            ? `${ASM_DOMAIN}/search/?q=${encodeURIComponent(baseFromSeriesId(mangaId))}`
            : `${ASM_DOMAIN}/g/${mangaId}/`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${ASM_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${ASM_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${AsmHentaiInfo.name}> and press the cloud icon.`)
        }
        if (status === 429) {
            throw new Error('The site is rate limiting this connection (HTTP 429). Wait a moment and try again.')
        }
        // A 5xx answer is an error page, not content; parsing one has
        // previously surfaced an error notice as a series title.
        if (status >= 500) {
            throw new Error(`The site returned an error (HTTP ${status}). It is probably down or overloaded -- try again shortly.`)
        }
        if (status < 200 || status >= 300) {
            throw new Error(`Unexpected response from the site (HTTP ${status}).`)
        }
    }

    /**
     * Short-lived memo for things worth not fetching twice -- chiefly the tag
     * catalogs, which cost a request per letter to gather.
     */
    private memo = new Map<string, { at: number; value: unknown; ttl: number }>()

    private remembered<T>(key: string): T | undefined {
        const entry = this.memo.get(key)
        if (entry == undefined) return undefined

        if (Date.now() - entry.at > entry.ttl) {
            this.memo.delete(key)
            return undefined
        }
        return entry.value as T
    }

    private remember(key: string, value: unknown, ttl: number = 120000): void {
        // It used to clear itself at forty entries. The fold now keeps what
        // each tile took in here, so opening the tile gathers it -- a page
        // leaves dozens of records, and clearing at forty would have thrown
        // them away within a page. Three thousand small entries holds a long
        // browse; the oldest third goes when it fills.
        if (this.memo.size > 3000) {
            const oldest = [...this.memo.entries()]
                .sort((a, b) => a[1].at - b[1].at)
                .slice(0, 1000)
            for (const [key] of oldest) this.memo.delete(key)
        }
        this.memo.set(key, { at: Date.now(), value: value, ttl: ttl })
    }

    /** This source's memo, as the shared fold sees it. */
    private get foldMemo(): FoldMemo {
        return {
            remember: (key: string, value: unknown, ttl?: number) => this.remember(key, value, ttl),
            remembered: <V>(key: string) => this.remembered<V>(key)
        }
    }

    private async fetchHtml(url: string): Promise<string> {
        const request = App.createRequest({ url: url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 3)
        this.checkResponse(response.status)
        return response.data as string
    }

    private async loadPage(url: string): Promise<CheerioAPI> {
        return cheerio.load(await this.fetchHtml(url))
    }

    private pagedUrl(path: string, page: number): string {
        return page <= 1 ? `${ASM_DOMAIN}${path}` : `${ASM_DOMAIN}${path}?page=${page}`
    }

    /**
     * Listing cards, with the English rule and the standing exclusions applied
     * from the cards' own annotations, so neither ever reaches the reader.
     *
     * Plain rows are returned rather than PartialSourceManga: the local
     * harnesses stub the App factories as identity functions, so a field read
     * back off a created object round-trips off-device and silently fails on
     * the phone.
     */
    private parseCards($: CheerioAPI): CardRow[] {
        const rows: CardRow[] = []

        // What an artist or group id is called, learned from every card on the
        // page whatever its language: one that shows both a caption credit and
        // an id says what that id is called. AsmHentai lists "NTR Jigo Houkoku
        // 2 After" with only a group id and "Toxic JK Netorare Jigo Houkoku"
        // with only a caption credit; its Chinese upload of the latter carries
        // both, which is how the two English books are known to be one circle's.
        for (const element of $('div.preview_item').toArray()) {
            const card = $(element)
            const names = creatorsOf(card.find('h2.caption').first().text().replace(/\s+/g, ' ').trim())
            if (names.length === 0) continue

            for (const id of creditIdsOf(card)) {
                const known = this.remembered<string[]>(`c:${id}`) ?? []
                this.remember(`c:${id}`, known.concat(names.filter((name) => !known.includes(name))), 3600000)
            }
        }

        for (const element of $('div.preview_item').toArray()) {
            const card = $(element)

            const languages = (card.attr('data-languages') ?? '').split(/\s+/).filter((id) => id.length > 0)
            if (!languages.includes(ENGLISH_LANGUAGE_ID)) continue

            const tagIds = (card.attr('data-tags') ?? '').split(/\s+/).filter((id) => id.length > 0)
            if (tagIds.some((id) => BANNED_TAG_IDS.has(id))) continue
            if (groupRefusedByIds(tagIds, GROUP_RULE)) continue

            const galleryId = /\/g\/(\d+)\//.exec(card.find('a[href^="/g/"]').first().attr('href') ?? '')?.[1]
            const raw = card.find('h2.caption').first().text().replace(/\s+/g, ' ').trim()
            if (galleryId == undefined || raw.length === 0) continue
            if (BANNED_LABELS.test(raw)) continue

            const multiWork = tagIds.includes(MULTI_WORK_TAG_ID)
            const { base, volume, marked } = splitTitle(raw, multiWork)

            // Scoped to the lazy-loaded cover: a card leads with a small
            // language flag image, so taking the first <img> yielded the flag
            // -- which has no data-src, leaving every tile without a cover.
            // The thumbnail is protocol-relative; https is required or the app
            // renders a blank page on iOS.
            let thumb = (card.find('div.image img[data-src], img[data-src]').first().attr('data-src') ?? '').trim()
            if (thumb.startsWith('//')) thumb = `https:${thumb}`

            const annotations: string[] = []
            for (const [attribute, type] of ANNOTATION_TYPES) {
                for (const id of (card.attr(attribute) ?? '').split(/\s+/)) {
                    if (id.length > 0) annotations.push(`${type}:${id}`)
                }
            }

            // A parody of something is dropped here, before it is ever shown.
            // The site's own "original" parody is the one that stays.
            const parodies = (card.attr('data-parodies') ?? '').split(/\s+/).filter((id) => id.length > 0)
            if (parodies.some((id) => id !== ORIGINAL_PARODY_ID)) continue

            const creators = creditIdsOf(card)
            for (const id of creators.slice()) {
                for (const name of this.remembered<string[]>(`c:${id}`) ?? []) {
                    if (!creators.includes(name)) creators.push(name)
                }
            }

            rows.push({
                galleryId: galleryId,
                raw: raw,
                multiWork: multiWork,
                creators: creators,
                base: base,
                title: marked ? base : (cleanTitle(raw) || raw),
                volume: volume,
                marked: marked,
                thumb: thumb,
                annotations: annotations
            })
        }

        return rows
    }

    /**
     * Collapses the cards on a page into one tile per series, by the same
     * rules as the nhentai source -- foldTiles in SeriesMerge.ts: numbered
     * volumes, the site's multi-work tag, and two titles credited to the same
     * creator whose names start or end alike, on one page or across pages.
     * The cards reaching here have already passed this source's own rules.
     */
    private tilesFrom(rows: CardRow[], seen: Set<string>): PartialSourceManga[] {
        const items: FoldItem<CardRow>[] = rows.map((row) => ({
            id: row.galleryId,
            raw: row.raw,
            thumb: row.thumb,
            multiWork: row.multiWork,
            // The card's artist and group ids, and the names they are known by
            // -- which hold even when the caption credits no one.
            creators: row.creators,
            payload: row
        }))

        return foldTiles(items, seen, this.foldMemo).map((tile) => App.createPartialSourceManga({
            mangaId: tile.id,
            image: tile.thumb,
            title: tile.title
        }))
    }

    /**
     * Walks a listing until it has a worthwhile batch or the listing ends.
     *
     * A tag listing cannot be scoped to English on the site -- every parameter
     * tried returns the same mixed page -- so a page of twenty often yields
     * only two English galleries. Handing those two back alone makes an
     * infinite scroll crawl, so a few pages are gathered into one batch.
     *
     * Paging is judged on the raw card count, never on the surviving tiles: a
     * thinned page is not the end of a listing.
     */
    private async pagedListing(path: string, page: number, seen: Set<string>, filters?: { include: string[]; exclude: string[] }): Promise<PagedResults> {
        const tiles: PartialSourceManga[] = []
        let current = page
        let exhausted = false

        for (let hop = 0; hop < 5; hop++) {
            const $ = await this.loadPage(this.pagedUrl(path, current))

            if ($('div.preview_item').length === 0) {
                exhausted = true
                break
            }

            const rows = filters == undefined
                ? this.parseCards($)
                : this.parseCards($).filter((row) => this.matches(row, filters))
            tiles.push(...this.tilesFrom(rows, seen))
            current++
            if (tiles.length >= 10) break
        }

        return App.createPagedResults({
            results: tiles,
            metadata: exhausted ? undefined : { page: current, seen: Array.from(seen) }
        })
    }

    /**
     * A chosen filter's numeric id, resolved from the site's own listing for
     * it: the id of that type carried by every card on `/tag/foo/` is the tag
     * itself. Needed because the catalogs are offered as slugs while the cards
     * annotate themselves with numbers, and the site's search has no minus
     * operator to lean on instead.
     *
     * Resolved once per filter and remembered; an unresolvable one is
     * remembered too, so a bad slug is not retried on every page.
     */
    private annotationIds = new Map<string, string | undefined>()

    private async annotationId(tagId: string): Promise<string | undefined> {
        if (this.annotationIds.has(tagId)) return this.annotationIds.get(tagId)

        const separator = tagId.indexOf(':')
        const type = separator < 0 ? 'tag' : tagId.slice(0, separator)
        const slug = separator < 0 ? tagId : tagId.slice(separator + 1)

        const attribute = (ANNOTATION_TYPES.find((entry) => entry[1] === type) ?? ['data-tags'])[0]
        let resolved: string | undefined

        try {
            const html = await this.fetchHtml(`${ASM_DOMAIN}/${type}/${slug}/`)

            const perCard = [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'g'))]
                .map((match) => (match[1] as string).split(/\s+/).filter((id) => id.length > 0))
            if (perCard.length > 0) {
                const common = perCard.reduce((carried, ids) => carried.filter((id) => ids.includes(id)), perCard[0] as string[])
                if (common.length === 1) resolved = common[0]
            }
        } catch {
            // Left unresolved; the filter is simply not applied.
        }

        this.annotationIds.set(tagId, resolved)
        return resolved
    }

    /**
     * The reader's chosen filters as card annotations. The first included one
     * is handled by browsing its own listing, so only the rest need applying
     * card by card.
     */
    private async resolveFilters(query: SearchRequest, skipFirstInclude: boolean): Promise<{ include: string[]; exclude: string[] }> {
        const includeTags = (query.includedTags ?? []).map((tag) => tag.id)
        const rest = skipFirstInclude ? includeTags.slice(1) : includeTags

        const include: string[] = []
        for (const id of rest) {
            const resolved = await this.annotationId(id)
            if (resolved != undefined) include.push(`${id.split(':')[0]}:${resolved}`)
        }

        const exclude: string[] = []
        for (const tag of query.excludedTags ?? []) {
            const resolved = await this.annotationId(tag.id)
            if (resolved != undefined) exclude.push(`${tag.id.split(':')[0]}:${resolved}`)
        }

        return { include: include, exclude: exclude }
    }

    private matches(row: CardRow, filters: { include: string[]; exclude: string[] }): boolean {
        if (filters.exclude.some((id) => row.annotations.includes(id))) return false
        return filters.include.every((id) => row.annotations.includes(id))
    }

    /**
     * Every gallery belonging to `base`, ordered by volume -- gathered as the
     * nhentai source gathers a series, by the shared rules in SeriesMerge.ts:
     * the site's search for the name; everything the listing folded into the
     * tile, taken on its word; and the artist's own listing, which is where
     * the volumes that each lead with a title of their own are. parseCards
     * holds every card to this source's rules -- English, the standing
     * exclusions, no parodies -- before any of this sees it.
     *
     * Remembered briefly: opening an entry asks for details and chapters back
     * to back, and both need this.
     */
    private async volumesOf(base: string): Promise<{ id: string; title: string; volume: number }[]> {
        const cacheKey = `v:${seriesKey(base)}`
        const cached = this.remembered<{ id: string; title: string; volume: number }[]>(cacheKey)
        if (cached != undefined) return cached

        const found = new Map<string, { id: string; title: string; volume: number; numbered: boolean }>()
        const books = new Set<string>()

        const byName = this.parseCards(await this.loadPage(this.searchUrl(base, 1)))
        const longName = isLongName(byName, base)

        const members: CardRow[] = []
        const consider = (rows: CardRow[], sameArtist: boolean, trusted: boolean = false): void => {
            for (const row of rows) {
                if (found.has(row.galleryId)) continue

                const verdict = volumeOf(row, base, longName, sameArtist, trusted, members)
                if (!verdict.belongs || books.has(verdict.book)) continue
                books.add(verdict.book)

                found.set(row.galleryId, { id: row.galleryId, title: verdict.title, volume: verdict.volume, numbered: verdict.numbered })
                members.push(row)
            }
        }

        consider(byName, false)
        consider(foldedInto<CardRow>(this.foldMemo, base).map((item) => item.payload), true, true)

        if (found.size > 0) {
            try {
                const first = orderVolumes(Array.from(found.values()))[0] as { id: string }
                const $ = await this.loadPage(`${ASM_DOMAIN}/g/${first.id}/`)
                const artists = this.metaRow($, 'Artists')
                const creator = artists[0] ?? this.metaRow($, 'Groups')[0]
                if (creator != undefined) {
                    const type = artists.length > 0 ? 'artist' : 'group'
                    const byArtist = this.parseCards(await this.loadPage(`${ASM_DOMAIN}/${type}/${creator.slug}/`))
                    consider(byArtist, true)
                    // Again: a volume can belong through a member the first
                    // pass found after it -- the newest volume comes first.
                    consider(byArtist, true)
                }
            } catch {
                // The name search and the listing's folds still stand.
            }
        }

        // An upload the site never tagged with its artist or group is not on
        // that listing -- AsmHentai's English "Toxic JK Netorare Jigo Houkoku"
        // is credited only in its caption. So the credit's own name is
        // searched as well, and a result joins only if it is credited to the
        // same people and its name is related to the series.
        if (found.size > 0) {
            const credits: string[] = []
            for (const row of members) {
                for (const name of creatorsOf(row.raw).concat(row.creators)) {
                    if (!credits.includes(name)) credits.push(name)
                }
            }

            for (const name of credits.filter((credit) => !credit.includes(':')).slice(0, 2)) {
                try {
                    const rows = this.parseCards(await this.loadPage(this.searchUrl(name, 1)))
                        .filter((row) => creatorsOf(row.raw).concat(row.creators).some((credit) => credits.includes(credit)))
                    consider(rows, true)
                } catch {
                    // One search fewer; the rest still stand.
                }
            }
        }

        const volumes = orderVolumes(Array.from(found.values()))

        // The cards were filtered before they got here, so this cannot tell
        // "excluded" from "not in English"; the message names both rules.
        if (volumes.length === 0) throw new Error(nothingToShow(base, 0, true))

        this.remember(cacheKey, volumes)
        return volumes
    }

    /** Resolves the gallery that should speak for an entry. */
    private async representativeId(mangaId: string): Promise<string> {
        if (!isSeriesId(mangaId)) return mangaId
        return ((await this.volumesOf(baseFromSeriesId(mangaId)))[0] as { id: string }).id
    }

    /**
     * Reads one labelled row out of the gallery's own metadata panel. The
     * panel is a run of `<h3>Label:</h3>` headings each followed by a
     * `.tag_list`, so the label is matched and its sibling list read.
     */
    private metaRow($: CheerioAPI, label: string): { slug: string; name: string }[] {
        const values: { slug: string; name: string }[] = []

        for (const element of $('h3').toArray()) {
            const heading = $(element)
            if (!heading.text().trim().toLowerCase().startsWith(label.toLowerCase())) continue

            for (const link of heading.nextAll('.tag_list').first().find('a').toArray()) {
                const href = $(link).attr('href') ?? ''
                const slug = /\/[a-z]+\/([^/"]+)\//.exec(href)?.[1]
                const name = $(link).text().replace(/\s*\([\d,]+\)\s*$/, '').replace(/\s+/g, ' ').trim()
                if (slug != undefined && name.length > 0) values.push({ slug: slug, name: name })
            }
            break
        }

        return values
    }

    /**
     * The gate. A gallery is refused when its own metadata carries a banned
     * name, or when it is not in English -- so nothing excluded can be read or
     * land in the library even from an old bookmark or a shared link.
     */
    private guard($: CheerioAPI): void {
        const tags = [
            ...this.metaRow($, 'Tags'),
            ...this.metaRow($, 'Categor')
        ]

        if (tags.some((tag) => BANNED_LABELS.test(tag.name) || BANNED_TAG_IDS.has(tag.slug))) {
            throw new Error('This gallery carries content excluded by your settings and will not be shown.')
        }
        if (groupRefusal(tags.map((tag) => tag.name)) != undefined) {
            throw new Error(GROUP_REFUSAL_MESSAGE)
        }

        // Anything filed under a parody other than the site's own "original"
        // is a parody of something, which is excluded.
        const parodies = this.metaRow($, 'Parodies').map((entry) => entry.slug)
        if (parodies.some((slug) => slug !== 'original')) {
            throw new Error('This gallery is a parody, which your settings exclude, and will not be shown.')
        }

        const languages = this.metaRow($, 'Languages').map((entry) => entry.slug)
        if (languages.length > 0 && !languages.includes('english')) {
            throw new Error('This gallery is not in English and will not be shown.')
        }
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const galleryId = await this.representativeId(mangaId)
        const $ = await this.loadPage(`${ASM_DOMAIN}/g/${galleryId}/`)
        this.guard($)

        const raw = $('h1').first().text().replace(/\s+/g, ' ').trim()
        const japanese = $('h2').first().text().replace(/\s+/g, ' ').trim()

        // A merged entry is named for the series, not for whichever volume
        // supplied the metadata.
        const title = isSeriesId(mangaId) ? baseFromSeriesId(mangaId) : (cleanTitle(raw) || raw)
        const titles = [title]
        for (const alternative of [raw, japanese]) {
            if (alternative.length > 0 && !titles.includes(alternative)) titles.push(alternative)
        }

        let cover = ($('img.lazy, .cover img').first().attr('data-src') ?? $('.cover img').first().attr('src') ?? '').trim()
        if (cover.startsWith('//')) cover = `https:${cover}`

        const tags: Tag[] = []
        const seen = new Set<string>()
        for (const [type, label] of [['tag', 'Tags'], ['artist', 'Artists'], ['parody', 'Parodies'], ['category', 'Categor']] as [string, string][]) {
            for (const entry of this.metaRow($, label)) {
                const id = `${type}:${entry.slug}`
                if (seen.has(id)) continue

                seen.add(id)
                tags.push(App.createTag({ id: id, label: entry.name }))
            }
        }

        const artists = this.metaRow($, 'Artists').map((entry) => entry.name)
        const pages = /Pages:\s*(\d+)/i.exec($.html() ?? '')?.[1]

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: titles,
                image: cover,
                desc: pages != undefined ? `${pages} pages.` : '',
                status: 'Completed',
                author: artists.join(', '),
                tags: tags.length > 0
                    ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })]
                    : []
            })
        })
    }

    /**
     * A merged series lists its volumes as chapters; a lone gallery is a
     * single chapter. The site publishes no upload date, so chapters carry
     * none rather than a fabricated one.
     */
    async getChapters(mangaId: string): Promise<Chapter[]> {
        if (!isSeriesId(mangaId)) {
            const $ = await this.loadPage(`${ASM_DOMAIN}/g/${mangaId}/`)
            this.guard($)

            const raw = $('h1').first().text().replace(/\s+/g, ' ').trim()
            return [App.createChapter({
                id: mangaId,
                chapNum: 1,
                name: cleanTitle(raw) || raw || 'Gallery',
                langCode: '🇬🇧',
                sortingIndex: 0
            })]
        }

        // volumesOf says why, in words, when nothing is left to show.
        const volumes = await this.volumesOf(baseFromSeriesId(mangaId))

        return volumes.map((volume, index) => App.createChapter({
            id: volume.id,
            chapNum: volume.volume,
            name: volume.title,
            langCode: '🇬🇧',
            sortingIndex: index
        }))
    }

    /**
     * The gallery page carries a thumbnail per page, and a page image is its
     * thumbnail without the trailing `t` -- verified against the CDN. Reading
     * the extension off each thumbnail rather than assuming `.jpg` keeps
     * galleries served as png or webp working.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const galleryId = /^\d+$/.test(chapterId) ? chapterId : await this.representativeId(mangaId)
        const html = await this.fetchHtml(`${ASM_DOMAIN}/g/${galleryId}/`)
        const $ = cheerio.load(html)
        this.guard($)

        const byNumber = new Map<number, string>()
        let shard = ''
        let extension = 'jpg'

        for (const match of html.matchAll(/\/\/images\.asmhentai\.com\/(\d+)\/(\d+)\/(\d+)t\.(\w+)/g)) {
            if ((match[2] as string) !== galleryId) continue

            shard = match[1] as string
            extension = match[4] as string
            byNumber.set(Number(match[3]), `https://images.asmhentai.com/${shard}/${galleryId}/${match[3]}.${extension}`)
        }

        // The grid can lag the declared page count, so any shortfall is filled
        // in from the pattern the thumbnails established.
        const declared = Number(/Pages:\s*(\d+)/i.exec(html)?.[1] ?? '0')
        if (shard.length > 0 && declared > byNumber.size) {
            for (let page = 1; page <= declared; page++) {
                if (!byNumber.has(page)) {
                    byNumber.set(page, `https://images.asmhentai.com/${shard}/${galleryId}/${page}.${extension}`)
                }
            }
        }

        const pages = [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])
        if (pages.length === 0) {
            throw new Error(`No pages were found for gallery ${galleryId}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    private searchUrl(title: string, page: number): string {
        const query = `${ASM_DOMAIN}/search/?q=${encodeURIComponent(title)}`
        return page <= 1 ? query : `${query}&page=${page}`
    }

    async getSearchResults(query: SearchRequest, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        const title = (query.title ?? '').trim()
        const selected = (query.includedTags ?? [])[0]?.id

        // A typed title goes through the site's search; its results are held
        // to the same card-level English and exclusion rules as any listing,
        // and to whatever the reader chose to include or leave out -- the
        // search itself takes no operators, so those are applied per card.
        if (title.length > 0) {
            const filters = await this.resolveFilters(query, false)
            const tiles: PartialSourceManga[] = []
            let current = page
            let exhausted = false

            // Walked the way listings are, and for a sharper reason: the
            // site's search cannot be told a language, so a page of twenty
            // results is about five English galleries before the standing
            // exclusions take their share of those. Reading a single page
            // returned nothing at all for a term the site answers with 17,640
            // galleries.
            for (let hop = 0; hop < 5; hop++) {
                const $ = await this.loadPage(this.searchUrl(title, current))

                if ($('div.preview_item').length === 0) {
                    exhausted = true
                    break
                }

                tiles.push(...this.tilesFrom(this.parseCards($).filter((row) => this.matches(row, filters)), seen))
                current++
                if (tiles.length >= 10) break
            }

            return App.createPagedResults({
                results: tiles,
                metadata: exhausted ? undefined : { page: current, seen: Array.from(seen) }
            })
        }

        // The first chosen filter browses its own listing, which the server can
        // do; any further ones, and everything to leave out, are applied per
        // card, since a listing cannot be narrowed by a second tag here.
        const typed = /^([a-z]+):(.+)$/.exec(selected ?? '')
        const path = typed != undefined
            ? `/${typed[1]}/${typed[2]}/`
            : (SECTIONS[0] as { path: string }).path

        const filters = await this.resolveFilters(query, typed != undefined)
        return this.pagedListing(path, page, seen, filters)
    }

    /**
     * Exclusion is offered. The site's search takes no minus operator, so it
     * is done against each card's own annotations instead. Whatever the reader
     * leaves out is on top of the standing exclusions, which cannot be undone.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    /**
     * The catalogs read live off the site's own indexes, with anything
     * matching the standing exclusions scrubbed from the offer -- advertising
     * a filter that cannot return anything is worse than not offering it.
     */
    /** Reads one index page into a slug/name map, banned names dropped. */
    private collectCatalog($: CheerioAPI, type: string, into: Map<string, string>): number {
        let added = 0

        for (const element of $(`a[href^="/${type}/"]`).toArray()) {
            const slug = new RegExp(`^/${type}/([^/"]+)/`).exec($(element).attr('href') ?? '')?.[1]
            const text = $(element).text().replace(/\s+/g, ' ').trim()
            const name = text.replace(/\s*\([\d,]+\)\s*$/, '').trim()
            if (slug == undefined || name.length === 0 || into.has(slug)) continue
            if (BANNED_LABELS.test(name) || BANNED_LABELS.test(slug.replace(/-/g, ' '))) continue

            // Each entry states how many galleries carry it. Anything below the
            // floor is noise rather than a genre -- misspellings, stray artist
            // names, one-offs -- and only clutters an alphabetical list.
            const count = Number((/\(([\d,]+)\)\s*$/.exec(text)?.[1] ?? '0').replace(/,/g, ''))
            if (count > 0 && count < MIN_CATALOG_GALLERIES) continue

            into.set(slug, name)
            added++
        }

        return added
    }

    /**
     * The catalogs, remembered for a day: they change slowly, and gathering
     * them is the most expensive thing this source does.
     *
     * A bare index only ever returns the hundred-odd most popular of its type,
     * which is what left most of the site's tags unreachable. Tags and parodies
     * are therefore walked a letter at a time, which is the only way the site
     * offers to see past that cap. Each letter is one request; the deeper
     * `?page=` runs behind each letter exist but are not followed, since that
     * would turn opening the filter screen into eighty-odd requests.
     *
     * Everything is sorted by name, so the list reads alphabetically rather
     * than by popularity.
     */
    async getSearchTags(): Promise<TagSection[]> {
        const cached = this.remembered<TagSection[]>('catalogs')
        if (cached != undefined) return cached

        const sections: TagSection[] = []

        for (const entry of TAG_TYPES) {
            const found = new Map<string, string>()

            try {
                this.collectCatalog(await this.loadPage(`${ASM_DOMAIN}${entry.path}`), entry.type, found)

                if (entry.byLetter) {
                    for (const letter of CATALOG_LETTERS) {
                        try {
                            this.collectCatalog(await this.loadPage(`${ASM_DOMAIN}${entry.path}${letter}/`), entry.type, found)
                        } catch {
                            // One missing letter is not worth losing the rest.
                        }
                    }
                }
            } catch {
                // A failed index leaves the other sections in place.
            }

            if (found.size === 0) continue

            const tags = [...found.entries()]
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map((pair) => App.createTag({ id: `${entry.type}:${pair[0]}`, label: pair[1] }))

            sections.push(App.createTagSection({ id: entry.type, label: entry.label, tags: tags }))
        }

        if (sections.length > 0) this.remember('catalogs', sections, 86400000)
        return sections
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // Reported once each, only after items are attached: a section whose
        // `items` is unset crashes the app when it reads the list.
        for (const entry of SECTIONS) {
            const section = App.createHomeSection({
                id: entry.id,
                title: entry.label,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: true,
                items: []
            })

            const $ = await this.loadPage(this.pagedUrl(entry.path, 1))
            section.items = this.tilesFrom(this.parseCards($), new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        const entry = SECTIONS.find((candidate) => candidate.id === homepageSectionId) ?? (SECTIONS[0] as { path: string })
        return this.pagedListing(entry.path, page, seen)
    }
}
