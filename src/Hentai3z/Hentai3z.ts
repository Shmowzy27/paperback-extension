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

/**
 * Galleries here are flat, like nhentai's -- a multi-volume doujin is several
 * separate titles -- so volumes are merged into one library entry by the rules
 * shared with the nhentai and AsmHentai sources in ../NHentai/SeriesMerge.ts.
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
    volumeOf
} from '../NHentai/SeriesMerge'
import { GROUP_REFUSAL_MESSAGE, groupRefusal } from '../NHentai/ContentRules'
import { PARODY_PHRASES } from './ParodyNames'
export { cleanTitle, splitTitle } from '../NHentai/SeriesMerge'

export const H3Z_DOMAIN = 'https://hentai3z.cc'

/**
 * Excluded by standing request, by name -- the site files its titles under
 * nhentai's own tag names ("Sole Female", "MMF Threesome", "Males Only"), so
 * this is the same pattern the other doujin sources carry. Listing cards here
 * carry no tags at all, so every card's own page is read before it is shown
 * (see admit) and this is checked against what that page lists.
 */
const BANNED_LABELS = /yaoi|boys?.?love|shounen[ -]?ai|\bmales only\b|tomgirl|crossdress|ugly bastard|\bbald\b|\bfat\b|gigantic breasts|\bold\s*m[ae]n\b|\bolder\s*m[ae]n\b|\bold\s*guy\b|\bgrandfather\b|\bgrandpa\b|\bgrand-?dad\b|\bgramps\b|\bdilf\b|reverse[- ]?harem|\bbbm\b|\bgang|\borgy\b|\b[mt]{2,}[mtf]\s*(?:threesome|foursome)\b|\bmm+f?\b|bestial|\bfurry\b|animal on|human on furry|octopus|\btentacl|\bmonster|\bslime\b|\binsect|\bsnake\b|\bspider\b|\bworm\b|\bcentaur\b|\bminotaur\b|\bhorse\b|\bdog\b|\bcat\b(?!\s*ears)|\bpig\b|\bfish\b|\bfrog\b|\bbird (?:girl|boy)\b|\bbear\b|\bwolf\b|\balien\b/i

/**
 * Tags this site carries beyond the shared pattern: "Trap", its older name for
 * tomgirl, and the animal-boy tags the shared pattern's words do not reach
 * ("Catboy", "Fox Boy", "Shark Boy" ...). Checked against tags only -- "trap"
 * in a title is as likely "Honey Trap". "Bunny Girl" is a costume, not an
 * animal, and is not here.
 */
const SITE_BANNED_LABELS = /\btrap\b|\bfemboy\b|\botokonoko\b|\bcatboy\b|\b(?:fox|bunny|shark|mouse|squid|racc?oon|monkey|lizard|deer|squirrel|sheep)\s*(?:boy|man)\b/i

/**
 * Anime and game parodies are excluded, leaving original works. The site has
 * no parody field, so three signals stand in for it:
 *
 * - its own "Anime" and "Game" tags, carried by parodies of those;
 * - a series or character name from nhentai's parody and character catalogs in
 *   the title -- "Eula's Drunken Escapade (Genshin Impact)", "Kijimuna plays
 *   with Astolfo" (see ParodyNames.ts for which names are used);
 * - the western comics' own convention of naming the parody in brackets before
 *   the artist -- "Triss Merigold (The Witcher) [PervertMuffinMajima]".
 */
const PARODY_TAG_SLUGS = new Set(['anime', 'game'])

const NOT_A_SERIES = /^(?:c\d+|comic\b|comitia|reitaisai|sc\d+|\d|vol|ch\b|chapter|part|english|uncensored|decensored|colou?ri[sz]ed|digital|josei|full colou?r|ongoing|complete)/i

const normalise = (text: string): string =>
    ' ' + text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' '

/** The parody a title names, if it names one. */
export const parodyIn = (title: string): string | undefined => {
    const western = /\(([^()]+)\)\s*\[[^\]]+\]\s*$/.exec(title)
    if (western != undefined && !NOT_A_SERIES.test((western[1] as string).trim())) return (western[1] as string).trim()

    const text = normalise(title)
    return PARODY_PHRASES.find((phrase) => text.includes(` ${phrase} `))
}

/** The site's own "multi-work series" tag: its word that a title has siblings. */
const MULTI_WORK_SLUG = 'multi-work-series'

/** A chapter published in another language, told by its slug or name. */
const NOT_ENGLISH = /^(?:raw|chinese|japanese|korean|spanish|thai|vietnamese|indonesian|french|german|portuguese|russian|italian|polish|arabic)\b/i

const SECTIONS: { id: string; label: string; sort?: string; genre?: string }[] = [
    { id: 'latest', label: 'Latest Updates', sort: 'lastest' },
    { id: 'views', label: 'Most Viewed', sort: 'views' },
    { id: 'manhwa', label: 'Manhwa', genre: 'mature' }
]

/** What a listing is: a sort of the whole catalog, a search, or one tag. */
interface Listing {
    sort?: string
    search?: string
    genre?: string
}

interface ListingMetadata {
    page?: number
    /** The shared fold's records of what earlier pages showed. */
    seen?: string[]
    /** Serial titles already shown; kept apart from the fold's own records. */
    serials?: string[]
}

interface Card {
    slug: string
    title: string
    thumb: string
}

interface ChapterRow {
    slug: string
    name: string
    number: number
    /** Publication date, epoch milliseconds; 0 when the page gives none. */
    time: number
}

/**
 * Everything a title's own page says, read once and remembered: the listing
 * needs it to decide whether a card may be shown, and opening the title then
 * costs nothing. `refusal` is why the standing rules refuse it, in words.
 */
interface Inspection {
    slug: string
    title: string
    altTitle: string
    artists: string[]
    author: string
    status: string
    genres: { slug: string; name: string }[]
    cover: string
    desc: string
    chapters: ChapterRow[]
    refusal?: string
}

interface Candidate {
    card: Card
    inspection?: Inspection
    refused: boolean
}

interface Volume {
    /** Upload order, for orderVolumes: the chapter's date. */
    id: number
    slug: string
    chapter: string
    title: string
    volume: number
    numbered: boolean
    time: number
}

export const isSeriesId = (mangaId: string): boolean => mangaId.startsWith(SERIES_PREFIX)
export const baseFromSeriesId = (mangaId: string): string => mangaId.slice(SERIES_PREFIX.length)

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * The reader's page list is base64. Decoded by hand: the app's JavaScript
 * engine has no atob and no Buffer.
 */
export const decodeBase64 = (input: string): string => {
    let bits = 0
    let value = 0
    let out = ''
    for (const char of input.replace(/[^A-Za-z0-9+/]/g, '')) {
        value = (value << 6) | BASE64.indexOf(char)
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out += String.fromCharCode((value >> bits) & 0xff)
            value &= (1 << bits) - 1
        }
    }
    return out
}

const absolute = (url: string): string => {
    const trimmed = url.trim()
    if (trimmed.length === 0) return ''
    if (trimmed.startsWith('//')) return `https:${trimmed}`
    if (trimmed.startsWith('/')) return `${H3Z_DOMAIN}${trimmed}`
    return trimmed.replace(/^http:\/\//, 'https://')
}

/** A title's slug from any link to it, relative or absolute. */
const slugOf = (href: string): string | undefined => /\/(?:hentai|comic)\/([^/?#"]+)\/?$/.exec(href)?.[1]

/** A title carrying several chapters is a serial -- a manhwa -- not a doujin volume. */
const isSerial = (inspection: Inspection): boolean =>
    inspection.chapters.length > 1 || inspection.chapters.some((chapter) => /^chapter-/i.test(chapter.slug))

/**
 * A chapter's number. Early manhwa chapters come in lettered parts -- slug
 * `1-a`, "Chapter 1A" -- which are numbered after their chapter, 1A as 1.1
 * and 1B as 1.2, so the parts read in order and never share a number.
 */
export const chapterNumber = (slug: string, name: string): number => {
    const match = /chapter\s*[- ]?(\d+(?:\.\d+)?)\s*-?\s*([a-i])?\b/i.exec(name)
        ?? /^(?:chapter-)?(\d+(?:\.\d+)?)(?:-([a-i]))?$/i.exec(slug)
    if (match == undefined) return NaN
    const part = match[2] != undefined ? ((match[2] as string).toLowerCase().charCodeAt(0) - 96) / 10 : 0
    return Number(match[1]) + part
}

const englishChapters = (inspection: Inspection): ChapterRow[] =>
    inspection.chapters.filter((chapter) => !NOT_ENGLISH.test(chapter.slug) && !NOT_ENGLISH.test(chapter.name))

/** The names a title is credited to, as the shared fold compares them. */
const creditsOf = (inspection: Inspection): string[] => {
    const names = creatorsOf(inspection.title)
    for (const artist of inspection.artists) {
        const name = seriesKey(artist)
        if (name.length >= 3 && !names.includes(name)) names.push(name)
    }
    return names
}

const titleRefusal = (title: string): boolean => BANNED_LABELS.test(title) || parodyIn(title) != undefined

/**
 * hentai3z.cc, filtered.
 *
 * The site sits behind a Cloudflare check, so the first visit may ask for the
 * cloud icon. Its listing cards carry a title and a cover and nothing else --
 * no tags, no artist -- so each card's own page is read before the card is
 * shown, and the standing exclusions, the group rule and the parody rule are
 * held against what that page lists. Twenty such pages come back in under a
 * second, measured live, and each is remembered so opening the title is free.
 */
export const Hentai3zInfo: SourceInfo = {
    version: '1.0.0',
    name: 'Hentai3z',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from hentai3z.cc with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: H3Z_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class Hentai3z implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 6,
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${H3Z_DOMAIN}/`,
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
            ? `${H3Z_DOMAIN}/list-manga?search=${encodeURIComponent(baseFromSeriesId(mangaId))}`
            : `${H3Z_DOMAIN}/hentai/${mangaId}`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${H3Z_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${H3Z_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private cloudflareError(): Error {
        return new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${Hentai3zInfo.name}> and press the cloud icon.`)
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) throw this.cloudflareError()
        if (status === 429) {
            throw new Error('The site is rate limiting this connection (HTTP 429). Wait a moment and try again.')
        }
        if (status >= 500) {
            throw new Error(`The site returned an error (HTTP ${status}). It is probably down or overloaded -- try again shortly.`)
        }
        if (status < 200 || status >= 300) {
            throw new Error(`Unexpected response from the site (HTTP ${status}).`)
        }
    }

    private async fetchHtml(url: string): Promise<string> {
        const response = await this.requestManager.schedule(App.createRequest({ url: url, method: 'GET' }), 2)
        this.checkResponse(response.status)
        const html = response.data as string
        // The challenge page can arrive with a success status.
        if (/<title>\s*Just a moment/i.test(html)) throw this.cloudflareError()
        return html
    }

    private async loadPage(url: string): Promise<CheerioAPI> {
        return cheerio.load(await this.fetchHtml(url))
    }

    /** Short-lived memo, bounded the way the other doujin sources bound theirs. */
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

    private listingUrl(listing: Listing, page: number): string {
        if (listing.genre != undefined) {
            return page <= 1
                ? `${H3Z_DOMAIN}/manga-list/${listing.genre}`
                : `${H3Z_DOMAIN}/manga-list/${listing.genre}/${page}`
        }
        const path = page <= 1 ? '/list-manga' : `/list-manga/${page}`
        const query = listing.search != undefined
            ? `search=${encodeURIComponent(listing.search)}`
            : `order_by=${listing.sort ?? 'lastest'}`
        return `${H3Z_DOMAIN}${path}?${query}`
    }

    /**
     * Listing cards. Plain rows rather than PartialSourceManga: the local
     * harnesses stub the App factories as identity functions, so a field read
     * back off a created object would round-trip off-device and silently fail
     * on the phone.
     */
    private parseCards(html: string): Card[] {
        const $ = cheerio.load(html)
        const cards: Card[] = []
        const seen = new Set<string>()

        for (const element of $('div.story_item').toArray()) {
            const item = $(element)
            const anchor = item.find('.mg_name a').first()
            const slug = slugOf(anchor.attr('href') ?? '')
            const title = anchor.text().replace(/\s+/g, ' ').trim()
            if (slug == undefined || title.length === 0 || seen.has(slug)) continue

            seen.add(slug)
            cards.push({ slug: slug, title: title, thumb: absolute(item.find('.story_images img').first().attr('src') ?? '') })
        }

        return cards
    }

    /**
     * A title's own page, read and judged. Remembered for half an hour: a
     * listing reads twenty of these, and opening any of them should not read
     * it again.
     */
    private async inspect(slug: string): Promise<Inspection> {
        const cached = this.remembered<Inspection>(`d:${slug}`)
        if (cached != undefined) return cached

        const $ = await this.loadPage(`${H3Z_DOMAIN}/hentai/${slug}`)

        const title = ($('.detail_name h1').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim() || slug

        // The panel is a run of rows, each a label and a value; the tag row is
        // the one whose value links to tag listings, and carries no label.
        const rows = $('.detail_listInfo .item').toArray().map((element) => $(element))
        const valueOf = (label: string) => rows.find((row) => row.find('.info_label').text().trim().toLowerCase().startsWith(label))?.find('.info_value')

        const artists = (valueOf('artist')?.find('a').toArray().map((element) => $(element).text().trim()) ?? [])
            .filter((name) => name.length > 0 && !/^updating$/i.test(name))
        const author = (valueOf('author')?.text() ?? '').replace(/\s+/g, ' ').trim()

        const genres: { slug: string; name: string }[] = []
        for (const element of $('.detail_listInfo a[href*="/manga-list/"]').toArray()) {
            const genre = /\/manga-list\/([^/?#"]+)\/?$/.exec($(element).attr('href') ?? '')?.[1]
            const name = $(element).text().replace(/\s+/g, ' ').trim()
            if (genre != undefined && name.length > 0 && !genres.some((known) => known.slug === genre)) genres.push({ slug: genre, name: name })
        }

        // The page has an "About" block and a "Summary" block; the summary is
        // the story.
        let desc = ''
        for (const element of $('.detail_review').toArray()) {
            const block = $(element)
            const content = block.find('.detail_reviewContent').text().replace(/\s+/g, ' ').trim()
            if (/summary/i.test(block.text().slice(0, 40)) || desc.length === 0) desc = content
        }

        const chapters: ChapterRow[] = []
        for (const element of $('a.chapter_num').toArray()) {
            const anchor = $(element)
            const chapter = new RegExp(`/(?:hentai|comic)/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/?#"]+)`).exec(anchor.attr('href') ?? '')?.[1]
            if (chapter == undefined || chapters.some((known) => known.slug === chapter)) continue

            const name = anchor.text().replace(/^\s*#\s*/, '').replace(/\s+/g, ' ').trim()
            const number = chapterNumber(chapter, name)
            const date = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(anchor.parent().find('p.chapter_info').first().text())
            const time = date != undefined ? new Date(Number(date[3]), Number(date[2]) - 1, Number(date[1])).getTime() : 0

            chapters.push({ slug: chapter, name: name.length > 0 ? name : chapter, number: number, time: time })
        }

        const inspection: Inspection = {
            slug: slug,
            title: title,
            altTitle: (valueOf('other name')?.text() ?? '').replace(/\s+/g, ' ').trim(),
            artists: artists,
            author: /^updating$/i.test(author) ? '' : author,
            status: /completed/i.test(valueOf('status')?.text() ?? '') ? 'Completed' : 'Ongoing',
            genres: genres,
            cover: absolute($('.detail_avatar img').first().attr('src') ?? ''),
            desc: desc,
            chapters: chapters
        }
        inspection.refusal = this.refusalOf(inspection)

        this.remember(`d:${slug}`, inspection, 1800000)
        return inspection
    }

    /** Why the standing rules refuse a title, in words; undefined when they do not. */
    private refusalOf(inspection: Inspection): string | undefined {
        const labels = inspection.genres.map((genre) => genre.name)

        const banned = labels.find((label) => BANNED_LABELS.test(label) || SITE_BANNED_LABELS.test(label))
        if (banned != undefined) return `This title is filed under "${banned}", which is excluded by your settings, and will not be shown.`

        if (groupRefusal(labels) != undefined) return GROUP_REFUSAL_MESSAGE

        const parodyTag = inspection.genres.find((genre) => PARODY_TAG_SLUGS.has(genre.slug))
        if (parodyTag != undefined) {
            return `This title is filed under "${parodyTag.name}" -- a parody -- and parodies are excluded by your settings, so it will not be shown.`
        }
        const parody = parodyIn(inspection.title) ?? parodyIn(inspection.altTitle)
        if (parody != undefined) {
            return `This title is a parody (${parody.trim()}), which your settings exclude, and will not be shown.`
        }

        if (BANNED_LABELS.test(inspection.title)) return 'This title carries content excluded by your settings and will not be shown.'

        if (inspection.chapters.length > 0 && englishChapters(inspection).length === 0) {
            return 'This title is not in English and will not be shown.'
        }
        return undefined
    }

    /**
     * A listing page's cards, each held to its own page. A title's name alone
     * sometimes gives it away, and then its page is not read at all.
     */
    private async gather(url: string): Promise<{ cards: number; candidates: Candidate[] }> {
        const cards = this.parseCards(await this.fetchHtml(url))

        const candidates = await Promise.all(cards.map(async (card): Promise<Candidate> => {
            if (titleRefusal(card.title)) return { card: card, refused: true }
            try {
                const inspection = await this.inspect(card.slug)
                return { card: card, inspection: inspection, refused: inspection.refusal != undefined }
            } catch {
                // A page that would not load cannot be vouched for.
                return { card: card, refused: true }
            }
        }))

        return { cards: cards.length, candidates: candidates }
    }

    private matches(inspection: Inspection, filters?: { include: string[]; exclude: string[] }): boolean {
        if (filters == undefined) return true
        const slugs = inspection.genres.map((genre) => genre.slug)
        if (filters.exclude.some((slug) => slugs.includes(slug))) return false
        return filters.include.every((slug) => slugs.includes(slug))
    }

    /**
     * One tile per series. A serial -- a manhwa with its own chapter list --
     * is always its own tile; doujin volumes go through the shared fold, in
     * runs between serials so the listing keeps its order.
     */
    private tilesFrom(candidates: Candidate[], seen: Set<string>, serials: Set<string>, filters?: { include: string[]; exclude: string[] }): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []
        let run: FoldItem<Inspection>[] = []

        const flush = (): void => {
            if (run.length === 0) return
            for (const tile of foldTiles(run, seen, this.foldMemo)) {
                tiles.push(App.createPartialSourceManga({ mangaId: tile.id, image: tile.thumb, title: tile.title }))
            }
            run = []
        }

        for (const candidate of candidates) {
            const inspection = candidate.inspection
            if (candidate.refused || inspection == undefined) continue
            if (inspection.chapters.length === 0 || !this.matches(inspection, filters)) continue

            if (isSerial(inspection)) {
                flush()
                if (serials.has(inspection.slug)) continue
                serials.add(inspection.slug)
                tiles.push(App.createPartialSourceManga({
                    mangaId: inspection.slug,
                    image: candidate.card.thumb || inspection.cover,
                    title: inspection.title
                }))
                continue
            }

            run.push({
                id: inspection.slug,
                raw: inspection.title,
                thumb: candidate.card.thumb || inspection.cover,
                multiWork: inspection.genres.some((genre) => genre.slug === MULTI_WORK_SLUG),
                creators: creditsOf(inspection),
                payload: inspection
            })
        }
        flush()

        return tiles
    }

    /**
     * Walks a listing until it has a worthwhile batch or the listing ends.
     * Paging is judged on the raw card count, never on the surviving tiles: a
     * thinned page is not the end of a listing.
     */
    private async pagedListing(listing: Listing, metadata: ListingMetadata | undefined, filters?: { include: string[]; exclude: string[] }): Promise<PagedResults> {
        const seen = new Set(metadata?.seen ?? [])
        const serials = new Set(metadata?.serials ?? [])
        const tiles: PartialSourceManga[] = []
        let current = metadata?.page ?? 1
        let exhausted = false

        for (let hop = 0; hop < 3; hop++) {
            const page = await this.gather(this.listingUrl(listing, current))
            if (page.cards === 0) {
                exhausted = true
                break
            }

            tiles.push(...this.tilesFrom(page.candidates, seen, serials, filters))
            current++
            if (tiles.length >= 8) break
        }

        return App.createPagedResults({
            results: tiles,
            metadata: exhausted ? undefined : { page: current, seen: Array.from(seen), serials: Array.from(serials) }
        })
    }

    /**
     * Every volume belonging to `base`, ordered -- gathered by the shared
     * rules in SeriesMerge.ts: the site's search for the name; everything the
     * listing folded into the tile, taken on its word; and, since the site has
     * no artist pages and its search reads titles only, a search for each
     * credited name, which finds the volumes whose titles credit it. A volume
     * joins by a related name only when it is credited to the same people.
     */
    private async volumesOf(base: string): Promise<Volume[]> {
        const cacheKey = `v:${seriesKey(base)}`
        const cached = this.remembered<Volume[]>(cacheKey)
        if (cached != undefined) return cached

        const found = new Map<string, Volume>()
        const books = new Set<string>()
        const members: { raw: string; multiWork: boolean }[] = []
        const credits: string[] = []
        let refused = 0

        const asCandidate = (row: Candidate): { raw: string; multiWork: boolean } => ({
            raw: row.inspection?.title ?? row.card.title,
            multiWork: (row.inspection?.genres ?? []).some((genre) => genre.slug === MULTI_WORK_SLUG)
        })

        const byName = (await this.gather(this.listingUrl({ search: base }, 1))).candidates
        const longName = isLongName(byName.map(asCandidate), base)

        const consider = (rows: Candidate[], sameArtist: boolean, trusted: boolean = false): void => {
            for (const row of rows) {
                const inspection = row.inspection
                const slug = inspection?.slug ?? row.card.slug
                if (found.has(slug)) continue
                if (inspection != undefined && isSerial(inspection)) continue

                const credited = sameArtist && inspection != undefined && creditsOf(inspection).some((name) => credits.includes(name))
                const verdict = volumeOf(asCandidate(row), base, longName, credited, trusted, members)
                if (!verdict.belongs) continue

                const chapter = inspection != undefined ? englishChapters(inspection)[0] : undefined
                if (row.refused || inspection == undefined || chapter == undefined) {
                    refused++
                    continue
                }
                if (books.has(verdict.book)) continue
                books.add(verdict.book)

                found.set(slug, {
                    id: chapter.time, slug: slug, chapter: chapter.slug, title: verdict.title,
                    volume: verdict.volume, numbered: verdict.numbered, time: chapter.time
                })
                members.push(asCandidate(row))
                for (const name of creditsOf(inspection)) {
                    if (!credits.includes(name)) credits.push(name)
                }
            }
        }

        consider(byName, false)
        consider(foldedInto<Inspection>(this.foldMemo, base).map((item) => ({
            card: { slug: item.id, title: item.raw, thumb: item.thumb },
            inspection: item.payload,
            refused: item.payload.refusal != undefined
        })), true, true)

        // The name search again, now that the series' credits are known, and
        // a search for each credited name.
        if (found.size > 0 && credits.length > 0) {
            const pool = byName.slice()
            for (const name of credits.slice(0, 2)) {
                try {
                    pool.push(...(await this.gather(this.listingUrl({ search: name }, 1))).candidates)
                } catch {
                    // One search fewer; the rest still stand.
                }
            }
            consider(pool, true)
            // Again: a volume can belong through a member found after it.
            consider(pool, true)
        }

        const volumes = orderVolumes(Array.from(found.values()))
        if (volumes.length === 0) throw new Error(nothingToShow(base, refused, true))

        this.remember(cacheKey, volumes)
        return volumes
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        let inspection: Inspection
        let title: string
        if (isSeriesId(mangaId)) {
            const base = baseFromSeriesId(mangaId)
            inspection = await this.inspect(((await this.volumesOf(base))[0] as Volume).slug)
            // A merged entry is named for the series, not for whichever volume
            // supplied the metadata.
            title = base
        } else {
            inspection = await this.inspect(mangaId)
            if (inspection.refusal != undefined) throw new Error(inspection.refusal)
            title = isSerial(inspection) ? inspection.title : (cleanTitle(inspection.title) || inspection.title)
        }

        const titles = [title]
        for (const alternative of [inspection.title, inspection.altTitle]) {
            if (alternative.length > 0 && !titles.includes(alternative)) titles.push(alternative)
        }

        const tags: Tag[] = inspection.genres.map((genre) => App.createTag({ id: genre.slug, label: genre.name }))

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: titles,
                image: inspection.cover,
                desc: inspection.desc,
                status: isSeriesId(mangaId) || !isSerial(inspection) ? 'Completed' : inspection.status,
                author: inspection.artists.join(', ') || inspection.author,
                artist: inspection.artists.join(', '),
                tags: tags.length > 0 ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })] : []
            })
        })
    }

    /**
     * A merged series lists its volumes as chapters; a manhwa its own
     * chapters; a single doujin is one chapter. Chapter ids carry the title's
     * slug, since a series' chapters are different titles' pages.
     */
    async getChapters(mangaId: string): Promise<Chapter[]> {
        if (isSeriesId(mangaId)) {
            const volumes = await this.volumesOf(baseFromSeriesId(mangaId))
            return volumes.map((volume, index) => App.createChapter({
                id: `${volume.slug}/${volume.chapter}`,
                chapNum: volume.volume,
                name: volume.title,
                langCode: '🇬🇧',
                sortingIndex: index,
                ...(volume.time > 0 ? { time: new Date(volume.time) } : {})
            }))
        }

        const inspection = await this.inspect(mangaId)
        if (inspection.refusal != undefined) throw new Error(inspection.refusal)

        // The site lists newest first. Numbered chapters are put in order by
        // number; anything unnumbered keeps the site's order, reversed.
        const rows = englishChapters(inspection).map((chapter, index) => ({ chapter: chapter, order: -index }))
        rows.sort((a, b) => (!isNaN(a.chapter.number) && !isNaN(b.chapter.number))
            ? a.chapter.number - b.chapter.number
            : a.order - b.order)

        const serial = isSerial(inspection)
        return rows.map((row, index) => App.createChapter({
            id: `${inspection.slug}/${row.chapter.slug}`,
            chapNum: isNaN(row.chapter.number) ? index + 1 : row.chapter.number,
            name: serial ? row.chapter.name : (cleanTitle(inspection.title) || inspection.title),
            langCode: '🇬🇧',
            sortingIndex: index,
            ...(row.chapter.time > 0 ? { time: new Date(row.chapter.time) } : {})
        }))
    }

    /**
     * The reader embeds its pages as `var slides_p_path = [...]`, each a
     * base64-encoded image URL on the site's image host.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const bar = chapterId.lastIndexOf('/')
        const slug = bar > 0 ? chapterId.slice(0, bar) : mangaId
        const chapter = bar > 0 ? chapterId.slice(bar + 1) : chapterId

        // Refused here too, so nothing excluded can be read from an old
        // bookmark or a shared link.
        const inspection = await this.inspect(slug)
        if (inspection.refusal != undefined) throw new Error(inspection.refusal)

        const html = await this.fetchHtml(`${H3Z_DOMAIN}/hentai/${slug}/${chapter}`)
        const body = /slides_p_path\s*=\s*\[([^\]]*)\]/.exec(html)?.[1] ?? ''

        const pages: string[] = []
        for (const match of body.matchAll(/["']([^"']+)["']/g)) {
            const entry = (match[1] as string).trim()
            const url = /^(?:https?:)?\/\//.test(entry) ? entry : decodeBase64(entry)
            if (/^(?:https?:)?\/\//.test(url)) pages.push(absolute(url))
        }

        if (pages.length === 0) {
            throw new Error(`No pages were found for ${slug}/${chapter}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    async getSearchResults(query: SearchRequest, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const title = (query.title ?? '').trim()
        const included = (query.includedTags ?? []).map((tag) => tag.id)
        const excluded = (query.excludedTags ?? []).map((tag) => tag.id)

        // A typed title goes through the site's search and every chosen tag is
        // applied per title. Otherwise the first chosen tag is browsed as its
        // own listing, which the site can do, and the rest are applied per
        // title -- a listing cannot be narrowed by a second tag here.
        if (title.length > 0) {
            return this.pagedListing({ search: title }, metadata, { include: included, exclude: excluded })
        }
        if (included.length > 0) {
            return this.pagedListing({ genre: included[0] }, metadata, { include: included.slice(1), exclude: excluded })
        }
        return this.pagedListing({ sort: 'lastest' }, metadata, { include: [], exclude: excluded })
    }

    /**
     * Exclusion is offered: every title's tags are read before it is shown,
     * so leaving a tag out is exact. It is on top of the standing exclusions,
     * which cannot be undone.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    /**
     * The site's tag index, read off its catalog page, alphabetical, with
     * anything the standing rules exclude left out of the offer -- advertising
     * a filter that cannot return anything is worse than not offering it.
     */
    async getSearchTags(): Promise<TagSection[]> {
        const cached = this.remembered<TagSection[]>('catalog')
        if (cached != undefined) return cached

        const found = new Map<string, string>()
        try {
            const $ = await this.loadPage(`${H3Z_DOMAIN}/list-manga`)
            for (const element of $('a[href*="/manga-list/"]').toArray()) {
                const slug = /\/manga-list\/([^/?#"]+)\/?$/.exec($(element).attr('href') ?? '')?.[1]
                const name = $(element).text().replace(/\s+/g, ' ').trim()
                if (slug == undefined || name.length === 0 || found.has(slug)) continue
                if (BANNED_LABELS.test(name) || SITE_BANNED_LABELS.test(name) || PARODY_TAG_SLUGS.has(slug)) continue
                found.set(slug, name)
            }
        } catch {
            return []
        }

        const tags = [...found.entries()]
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([slug, name]) => App.createTag({ id: slug, label: name }))

        const sections = tags.length > 0 ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })] : []
        if (sections.length > 0) this.remember('catalog', sections, 86400000)
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

            const page = await this.gather(this.listingUrl({ sort: entry.sort, genre: entry.genre }, 1))
            section.items = this.tilesFrom(page.candidates, new Set<string>(), new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const entry = SECTIONS.find((candidate) => candidate.id === homepageSectionId) ?? (SECTIONS[0] as { sort?: string; genre?: string })
        return this.pagedListing({ sort: entry.sort, genre: entry.genre }, metadata)
    }
}
