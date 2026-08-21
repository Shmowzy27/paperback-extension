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
const BANNED_TAG_IDS = new Set(['13', '32', '88', '87', '534'])
const BANNED_LABELS = /yaoi|boys?.?love|shounen[ -]?ai|males only|tomgirl|crossdress|ugly bastard|\bbald\b|\bfat\b/i

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
 * Browsable catalogs, the way the sibling sources offer theirs. Each index
 * lists the site's most popular hundred-odd of that type.
 */
const TAG_TYPES: { type: string; path: string; label: string }[] = [
    { type: 'tag', path: '/tags/', label: 'Tags' },
    { type: 'artist', path: '/artists/', label: 'Artists' },
    { type: 'parody', path: '/parodies/', label: 'Parodies' }
]

/**
 * Galleries here are flat -- a multi-volume work is published as several
 * separate galleries -- so volumes are merged into one library entry the way
 * HentaiNexus and the nhentai source do it.
 */
const VOLUME = '(\\d{1,3}(?:\\.\\d{1,2})?)'
const SUBTITLE = '(?:\\s*[:\\-–—]\\s*.+)?'

const VOLUME_PATTERNS: RegExp[] = [
    new RegExp(`^(.*?\\S)\\s+(?:ch\\.?|chapter)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s+(?:vol\\.?|volume)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s+(?:part|pt\\.?)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s*#\\s*${VOLUME}${SUBTITLE}$`),
    new RegExp(`^(.*?\\S)\\s+${VOLUME}${SUBTITLE}$`),
    // The number is often glued straight onto the last word ("NAGI3"), which
    // every whitespace-anchored pattern above misses.
    new RegExp(`^(.*?[A-Za-z])(\\d{1,2})$`)
]

/**
 * Titles arrive wrapped in circle, artist, language and scanlator brackets --
 * "[Circle (Artist)] Real Title 2 (Parody) [Digital]". Those are stripped
 * innermost-first and repeatedly, because one pass leaves the outer bracket of
 * a nested pair behind and a leftover "[Circle ]" poisons the series name.
 *
 * An alternative title after a pipe is dropped for the same reason it is on
 * nhentai: it puts the volume number in the middle of the string, so no
 * pattern matches and the other language ends up in the series name.
 */
export const cleanTitle = (raw: string): string => {
    let text = raw
    let previous = ''
    while (previous !== text) {
        previous = text
        text = text.replace(/[\[(（][^\[\]()（）]*[\])）]/g, '')
    }

    const halves = text.split('|').map((half) => half.trim()).filter((half) => half.length > 0)
    text = halves.length > 0 ? (halves[0] as string) : text

    return text.replace(/\s+/g, ' ').trim().replace(/^[-~:.\s]+|[-~:.\s]+$/g, '')
}

/**
 * `marked` says whether a volume number was actually found, which decides
 * whether the entry is treated as a series at all: a gallery with no volume
 * number cannot have siblings worth looking up, so it keeps its own id and
 * opens without a sibling search.
 */
export const splitTitle = (title: string): { base: string; volume: number; marked: boolean } => {
    const trimmed = cleanTitle(title)

    for (const pattern of VOLUME_PATTERNS) {
        const match = pattern.exec(trimmed)
        if (!match) continue

        const base = (match[1] as string).replace(/[\s\-–—:,.]+$/, '').trim()
        if (base.length > 0) return { base: base, volume: Number(match[2]), marked: true }
    }

    return { base: trimmed.length > 0 ? trimmed : title.trim(), volume: 1, marked: false }
}

const SERIES_PREFIX = 's:'
export const isSeriesId = (mangaId: string): boolean => mangaId.startsWith(SERIES_PREFIX)
export const baseFromSeriesId = (mangaId: string): string => mangaId.slice(SERIES_PREFIX.length)

interface ListingMetadata {
    page?: number
    seen?: string[]
}

interface CardRow {
    galleryId: string
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
    version: '1.1.0',
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

        for (const element of $('div.preview_item').toArray()) {
            const card = $(element)

            const languages = (card.attr('data-languages') ?? '').split(/\s+/).filter((id) => id.length > 0)
            if (!languages.includes(ENGLISH_LANGUAGE_ID)) continue

            const tagIds = (card.attr('data-tags') ?? '').split(/\s+/).filter((id) => id.length > 0)
            if (tagIds.some((id) => BANNED_TAG_IDS.has(id))) continue

            const galleryId = /\/g\/(\d+)\//.exec(card.find('a[href^="/g/"]').first().attr('href') ?? '')?.[1]
            const raw = card.find('h2.caption').first().text().replace(/\s+/g, ' ').trim()
            if (galleryId == undefined || raw.length === 0) continue
            if (BANNED_LABELS.test(raw)) continue

            const { base, volume, marked } = splitTitle(raw)

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

            rows.push({
                galleryId: galleryId,
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
     * Collapses the cards on a page into one entry per work. A numbered
     * gallery becomes a series so its volumes merge; an unnumbered one keeps
     * its own gallery id but is still keyed on its title, so the several
     * copies the site carries of one work collapse to a single tile.
     */
    private tilesFrom(rows: CardRow[], seen: Set<string>): PartialSourceManga[] {
        const grouped = new Map<string, CardRow>()

        for (const row of rows) {
            const key = row.base.toLowerCase()
            const existing = grouped.get(key)
            // The lowest-numbered volume supplies the cover.
            if (existing == undefined || row.volume < existing.volume) grouped.set(key, row)
        }

        const tiles: PartialSourceManga[] = []
        for (const [key, row] of grouped) {
            if (seen.has(key)) continue
            seen.add(key)

            tiles.push(App.createPartialSourceManga({
                mangaId: row.marked ? `${SERIES_PREFIX}${row.base}` : row.galleryId,
                image: row.thumb,
                title: row.title
            }))
        }

        return tiles
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

    /** Every gallery belonging to `base`, ordered by volume. */
    private async volumesOf(base: string): Promise<{ id: string; title: string; volume: number }[]> {
        const $ = await this.loadPage(`${ASM_DOMAIN}/search/?q=${encodeURIComponent(base)}`)

        const wanted = base.toLowerCase()
        const volumes: { id: string; title: string; volume: number }[] = []
        const seen = new Set<string>()

        for (const row of this.parseCards($)) {
            if (row.base.toLowerCase() !== wanted || seen.has(row.galleryId)) continue

            seen.add(row.galleryId)
            volumes.push({ id: row.galleryId, title: row.title, volume: row.volume })
        }

        volumes.sort((a, b) => a.volume - b.volume)
        return volumes
    }

    /** Resolves the gallery that should speak for an entry. */
    private async representativeId(mangaId: string): Promise<string> {
        if (!isSeriesId(mangaId)) return mangaId

        const base = baseFromSeriesId(mangaId)
        const volumes = await this.volumesOf(base)
        if (volumes.length === 0) {
            throw new Error(`No volumes found for "${base}".`)
        }
        return (volumes[0] as { id: string }).id
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
            ...this.metaRow($, 'Categor'),
            ...this.metaRow($, 'Parodies')
        ]

        if (tags.some((tag) => BANNED_LABELS.test(tag.name) || BANNED_TAG_IDS.has(tag.slug))) {
            throw new Error('This gallery carries content excluded by your settings (BL/yaoi, ugly bastard, bald, tomgirl or crossdressing) and will not be shown.')
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

        const base = baseFromSeriesId(mangaId)
        const volumes = await this.volumesOf(base)
        if (volumes.length === 0) {
            throw new Error(`No volumes found for "${base}".`)
        }

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
            const $ = await this.loadPage(
                page <= 1
                    ? `${ASM_DOMAIN}/search/?q=${encodeURIComponent(title)}`
                    : `${ASM_DOMAIN}/search/?q=${encodeURIComponent(title)}&page=${page}`
            )
            const tiles = this.tilesFrom(this.parseCards($).filter((row) => this.matches(row, filters)), seen)

            return App.createPagedResults({
                results: tiles,
                metadata: $('div.preview_item').length === 0 ? undefined : { page: page + 1, seen: Array.from(seen) }
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
    async getSearchTags(): Promise<TagSection[]> {
        const sections: TagSection[] = []

        for (const entry of TAG_TYPES) {
            try {
                const $ = await this.loadPage(`${ASM_DOMAIN}${entry.path}`)

                const tags: Tag[] = []
                const seen = new Set<string>()
                for (const element of $(`a[href^="/${entry.type}/"]`).toArray()) {
                    const slug = new RegExp(`^/${entry.type}/([^/"]+)/`).exec($(element).attr('href') ?? '')?.[1]
                    const name = $(element).text().replace(/\s*\([\d,]+\)\s*$/, '').replace(/\s+/g, ' ').trim()
                    if (slug == undefined || name.length === 0 || seen.has(slug)) continue
                    if (BANNED_LABELS.test(name) || BANNED_LABELS.test(slug.replace(/-/g, ' '))) continue

                    seen.add(slug)
                    tags.push(App.createTag({ id: `${entry.type}:${slug}`, label: name }))
                }

                if (tags.length > 0) {
                    sections.push(App.createTagSection({ id: entry.type, label: entry.label, tags: tags }))
                }
            } catch {
                // A failed index leaves the other sections in place.
            }
        }

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
