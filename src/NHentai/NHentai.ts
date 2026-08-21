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

export const NH_DOMAIN = 'https://nhentai.net'
const NH_API = `${NH_DOMAIN}/api/v2`

/** The image CDN reported by /api/v2/cdn; any of i1-i4 serves every gallery. */
const NH_IMAGE_CDN = 'https://i1.nhentai.net'
const NH_THUMB_CDN = 'https://t1.nhentai.net'

/**
 * Excluded by standing request: no BL/yaoi/male-to-male content, and no ugly
 * bastard or bald content. The ids are nhentai's own, resolved live from
 * /api/v2/tags/tag/{slug} and re-verified against a yaoi gallery; there is no
 * "fat" tag on this site. The names feed the search negation and the ids the
 * client-side backstop, since listing entries carry only tag_ids.
 */
export const NH_BANNED: { id: number; name: string }[] = [
    { id: 23895, name: 'yaoi' },
    { id: 21712, name: 'males only' },
    { id: 162979, name: 'ugly bastard' },
    { id: 73750, name: 'bald' }
]

const BANNED_IDS = new Set(NH_BANNED.map((tag) => tag.id))

/**
 * Appended to every search the source makes. The API's own negation syntax, so
 * the server never returns the excluded content in the first place.
 */
const EXCLUSION = NH_BANNED.map((tag) => ` -tag:"${tag.name}"`).join('')

/**
 * A pure-negative query is rejected by the API, so browse surfaces need a
 * positive base. Language covers essentially the whole catalog split three
 * ways, which makes it both the base and a useful reader-facing filter.
 */
const LANGUAGES: { id: string; label: string }[] = [
    { id: 'english', label: 'English' },
    { id: 'japanese', label: 'Japanese' },
    { id: 'chinese', label: 'Chinese' }
]

const SECTIONS: { id: string; label: string; sort: string }[] = [
    { id: 'new', label: 'New Uploads (English)', sort: 'date' },
    { id: 'popular-week', label: 'Popular This Week (English)', sort: 'popular-week' },
    { id: 'popular', label: 'All-Time Popular (English)', sort: 'popular' }
]

/**
 * Galleries on nhentai are flat: a multi-volume work is published as several
 * separate galleries, exactly the shape HentaiNexus faces. So volumes are
 * merged into one library entry the same way -- the trailing volume number is
 * stripped off the title and what remains is the series.
 *
 * The sister sites need none of this: hentaihere and hentai2read already model
 * a series with several chapters natively.
 */
const VOLUME = '(\\d{1,3}(?:\\.\\d{1,2})?)'
const SUBTITLE = '(?:\\s*[:\\-–—]\\s*.+)?'

const VOLUME_PATTERNS: RegExp[] = [
    new RegExp(`^(.*?\\S)\\s+(?:ch\\.?|chapter)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s+(?:vol\\.?|volume)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s+(?:part|pt\\.?)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s*#\\s*${VOLUME}${SUBTITLE}$`),
    new RegExp(`^(.*?\\S)\\s+${VOLUME}${SUBTITLE}$`),
    // "WASANBON NAGI3" -- this site frequently glues the number straight onto
    // the last word, which every whitespace-anchored pattern above misses.
    new RegExp(`^(.*?[A-Za-z])(\\d{1,2})$`)
]

/**
 * Titles arrive wrapped in circle, artist, language and scanlator brackets --
 * "[Circle (Artist)] Real Title 2 (Parody) [Digital]". Those are stripped
 * innermost-first and repeatedly, because a single pass leaves the outer
 * bracket of a nested pair behind and the leftover "[Circle ]" poisons the
 * series name.
 */
export const cleanTitle = (raw: string): string => {
    let text = raw
    let previous = ""
    while (previous !== text) {
        previous = text
        text = text.replace(/[\[(（][^\[\]()（）]*[\])）]/g, '')
    }
    return text.replace(/\s+/g, ' ').trim().replace(/^[-~:\s]+|[-~:\s]+$/g, '')
}

export const splitTitle = (title: string): { base: string; volume: number } => {
    const trimmed = cleanTitle(title)

    for (const pattern of VOLUME_PATTERNS) {
        const match = pattern.exec(trimmed)
        if (!match) continue

        const base = (match[1] as string).replace(/[\s\-–—:,]+$/, '').trim()
        if (base.length > 0) return { base: base, volume: Number(match[2]) }
    }

    return { base: trimmed.length > 0 ? trimmed : title.trim(), volume: 1 }
}

const SERIES_PREFIX = 's:'
export const seriesIdFor = (title: string): string => `${SERIES_PREFIX}${splitTitle(title).base}`
export const isSeriesId = (mangaId: string): boolean => mangaId.startsWith(SERIES_PREFIX)
export const baseFromSeriesId = (mangaId: string): string => mangaId.slice(SERIES_PREFIX.length)

/**
 * The phrase used to find a series' other volumes. Quotes are stripped and a
 * leading minus neutralised: both are search operators here, and letting them
 * through turns the lookup into a different query -- the same failure that once
 * left HentaiNexus reporting "No volumes found" for any title holding one.
 */
export const seriesQuery = (base: string): string => {
    const phrase = base.replace(/["]/g, ' ').replace(/(^|\s)-+/g, '$1').replace(/\s+/g, ' ').trim()
    return phrase.length > 0 ? `"${phrase}"` : base
}

interface ApiListing {
    id: number
    english_title?: string
    japanese_title?: string
    thumbnail?: string
    tag_ids?: number[]
}

interface ApiTag {
    id: number
    type: string
    name: string
}

interface ApiGallery {
    id: number
    media_id: string
    title?: { english?: string; pretty?: string }
    cover?: { path?: string }
    thumbnail?: string
    upload_date?: number
    tags?: ApiTag[]
    num_pages?: number
    pages?: { path?: string }[]
}

interface ListingMetadata {
    page?: number
    seen?: string[]
}

/**
 * nhentai through its own v2 JSON API.
 *
 * Volumes published as separate galleries are merged into one library entry
 * the way HentaiNexus does it, since this site models no series of its own.
 * Each volume becomes a chapter of that entry.
 *
 * Excluded by construction: the standing BL/yaoi rule plus ugly bastard and
 * bald, negated inside every search query so the server filters, and every
 * returned entry re-checked against the banned tag ids as the backstop.
 */
export const NHentaiInfo: SourceInfo = {
    version: '1.2.0',
    name: 'nhentai (Filtered)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls galleries from nhentai.net with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: NH_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class NHentai implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        // The API's anonymous ceiling is fifteen requests a minute, and it
        // answers 429 past it, so this sits exactly on that budget.
        //
        // It used to pace at one every five seconds, which was well inside the
        // budget but made opening an entry take twenty seconds -- four requests
        // apiece, because details and chapters each ran their own sibling
        // search. The memo below cut that to two, so the same safe rate now
        // opens an entry in about four seconds.
        requestsPerSecond: 0.25,
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${NH_DOMAIN}/`,
                        'accept': 'application/json',
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

    /**
     * A merged series has no page of its own on the site, so sharing one
     * points at the search for its name; a plain gallery id links directly.
     */
    getMangaShareUrl(mangaId: string): string {
        return isSeriesId(mangaId)
            ? `${NH_DOMAIN}/search/?q=${encodeURIComponent(seriesQuery(baseFromSeriesId(mangaId)))}`
            : `${NH_DOMAIN}/g/${mangaId}/`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${NH_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${NH_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${NHentaiInfo.name}> and press the cloud icon.`)
        }
        if (status === 429) {
            throw new Error('nhentai is rate limiting (HTTP 429). Wait a minute and try again.')
        }
        if (status >= 500) {
            throw new Error(`The site returned an error (HTTP ${status}). It is probably down or overloaded -- try again shortly.`)
        }
        if (status < 200 || status >= 300) {
            throw new Error(`Unexpected response from the site (HTTP ${status}).`)
        }
    }

    /**
     * Short-lived memo of things just fetched, so that opening an entry costs
     * one round of requests rather than two.
     *
     * Paperback calls getMangaDetails and getChapters back to back, and both
     * need the same sibling search and the same gallery record; without this
     * each open paid for them twice. Entries are dropped after a couple of
     * minutes so a refresh still sees new volumes.
     */
    private memo = new Map<string, { at: number; value: unknown }>()

    private remembered<T>(key: string): T | undefined {
        const entry = this.memo.get(key)
        if (entry == undefined) return undefined

        if (Date.now() - entry.at > 120000) {
            this.memo.delete(key)
            return undefined
        }
        return entry.value as T
    }

    private remember(key: string, value: unknown): void {
        // Bounded so a long browse cannot grow it without limit.
        if (this.memo.size > 40) this.memo.clear()
        this.memo.set(key, { at: Date.now(), value: value })
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const request = App.createRequest({ url: url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 3)
        this.checkResponse(response.status)
        return JSON.parse(response.data as string) as T
    }

    /** A gallery record, reused if it was fetched moments ago. */
    private async gallery(galleryId: number | string): Promise<ApiGallery> {
        const key = `g:${galleryId}`
        const cached = this.remembered<ApiGallery>(key)
        if (cached != undefined) return cached

        const gallery = await this.fetchJson<ApiGallery>(`${NH_API}/galleries/${galleryId}`)
        this.remember(key, gallery)
        return gallery
    }

    /** URL-safe form of a search query, negations included. */
    private searchUrl(query: string, sort: string, page: number): string {
        return `${NH_API}/search?query=${encodeURIComponent(query + EXCLUSION)}&sort=${sort}&page=${page}`
    }

    /**
     * The banned tag ids, checked on every entry the API hands back even
     * though the query already negates them -- the backstop costs nothing and
     * guards against the server-side syntax ever changing under us.
     */
    private admitted(tagIds: number[] | undefined): boolean {
        return !(tagIds ?? []).some((id) => BANNED_IDS.has(id))
    }

    /**
     * Collapses the volumes on a page into one entry per series, the way
     * HentaiNexus does: the lowest-numbered volume supplies the cover, and the
     * series name is what the entry is called.
     *
     * `seen` carries the series already handed out by earlier pages, so a
     * series straddling a page boundary is not emitted twice.
     */
    private tilesFrom(entries: ApiListing[], seen: Set<string>): PartialSourceManga[] {
        const series = new Map<string, { base: string; volume: number; thumb: string }>()

        for (const entry of entries) {
            if (!this.admitted(entry.tag_ids)) continue

            const raw = (entry.english_title ?? entry.japanese_title ?? `Gallery ${entry.id}`).trim()
            const { base, volume } = splitTitle(raw)
            const key = base.toLowerCase()

            const existing = series.get(key)
            if (existing == undefined) {
                series.set(key, { base: base, volume: volume, thumb: (entry.thumbnail ?? '').replace(/^\/+/, '') })
            } else if (volume < existing.volume) {
                existing.volume = volume
                existing.thumb = (entry.thumbnail ?? '').replace(/^\/+/, '')
            }
        }

        const tiles: PartialSourceManga[] = []
        for (const [key, entry] of series) {
            const id = `s:${entry.base}`
            if (seen.has(key)) continue
            seen.add(key)

            tiles.push(App.createPartialSourceManga({
                mangaId: id,
                image: entry.thumb.length > 0 ? `${NH_THUMB_CDN}/${entry.thumb}` : '',
                title: entry.base
            }))
        }

        return tiles
    }

    /**
     * Every gallery belonging to `base`, ordered by volume. One search finds
     * them; the query already negates the excluded tags, and each result is
     * re-checked before it is accepted.
     */
    private async volumesOf(base: string): Promise<{ id: number; title: string; volume: number }[]> {
        const key = `v:${base.toLowerCase()}`
        const cached = this.remembered<{ id: number; title: string; volume: number }[]>(key)
        if (cached != undefined) return cached

        const data = await this.fetchJson<{ result?: ApiListing[] }>(
            this.searchUrl(seriesQuery(base), 'date', 1)
        )

        const wanted = base.toLowerCase()
        const volumes: { id: number; title: string; volume: number }[] = []
        const seen = new Set<number>()

        for (const entry of data.result ?? []) {
            if (seen.has(entry.id) || !this.admitted(entry.tag_ids)) continue

            const raw = (entry.english_title ?? entry.japanese_title ?? '').trim()
            const split = splitTitle(raw)
            if (split.base.toLowerCase() !== wanted) continue

            seen.add(entry.id)
            volumes.push({ id: entry.id, title: cleanTitle(raw) || raw, volume: split.volume })
        }

        volumes.sort((a, b) => a.volume - b.volume)
        this.remember(key, volumes)
        return volumes
    }

    private async pagedSearch(query: string, sort: string, page: number, seen: Set<string>): Promise<PagedResults> {
        const data = await this.fetchJson<{ result?: ApiListing[]; num_pages?: number }>(this.searchUrl(query, sort, page))

        const entries = data.result ?? []
        const tiles = this.tilesFrom(entries, seen)
        const lastPage = page >= (data.num_pages ?? 1) || entries.length === 0

        return App.createPagedResults({
            results: tiles,
            metadata: lastPage ? undefined : { page: page + 1, seen: Array.from(seen) }
        })
    }

    /**
     * Resolves whichever gallery should speak for an entry: the first volume
     * of a merged series, or the gallery itself for a plain numeric id (which
     * is what a library entry from before merging, or a shared link, carries).
     */
    private async representativeId(mangaId: string): Promise<number> {
        if (!isSeriesId(mangaId)) return Number(mangaId)

        const base = baseFromSeriesId(mangaId)
        const volumes = await this.volumesOf(base)
        if (volumes.length === 0) {
            throw new Error(`No volumes found for "${base}".`)
        }
        return (volumes[0] as { id: number }).id
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const galleryId = await this.representativeId(mangaId)
        const gallery = await this.gallery(galleryId)

        const tags = gallery.tags ?? []
        // A merged entry is named for the series, not for whichever volume
        // happened to supply the metadata.
        const galleryTitle = (gallery.title?.pretty ?? gallery.title?.english ?? `Gallery ${mangaId}`).trim()
        const title = isSeriesId(mangaId) ? baseFromSeriesId(mangaId) : galleryTitle
        const fullTitle = (gallery.title?.english ?? galleryTitle).trim()

        const artists = tags.filter((tag) => tag.type === 'artist').map((tag) => tag.name)

        // Tag sections mirror the API's own types, the same way HentaiNexus
        // exposes its categories. Banned tags cannot appear here -- a gallery
        // carrying one refuses to open below -- so no scrubbing is needed.
        const byType = new Map<string, Tag[]>()
        for (const tag of tags) {
            const list = byType.get(tag.type) ?? []
            list.push(App.createTag({ id: `${tag.type}:${tag.name}`, label: tag.name }))
            byType.set(tag.type, list)
        }

        const sections: TagSection[] = []
        for (const [type, list] of byType) {
            sections.push(App.createTagSection({ id: type, label: type.charAt(0).toUpperCase() + type.slice(1), tags: list }))
        }

        // The gate: a gallery carrying a banned tag is refused outright, so
        // even an old bookmark or a shared link cannot open one.
        if (tags.some((tag) => BANNED_IDS.has(tag.id))) {
            throw new Error('This gallery carries content excluded by your settings (BL/yaoi, ugly bastard or bald) and will not be shown.')
        }

        const cover = (gallery.cover?.path ?? gallery.thumbnail ?? '').replace(/^\/+/, '')

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: fullTitle === title ? [title] : [title, fullTitle],
                image: cover.length > 0 ? `${NH_THUMB_CDN}/${cover}` : '',
                desc: `${gallery.num_pages ?? '?'} pages.`,
                status: 'Completed',
                author: artists.join(', '),
                tags: sections
            })
        })
    }

    /**
     * Each volume of the series becomes a chapter, keyed on its gallery id.
     *
     * Upload dates live only on a gallery's own record, never in search
     * results, so they cost one request per volume. That is affordable for the
     * handful of volumes a series here runs to, but the API allows only
     * fifteen requests a minute, so a runaway group is capped rather than
     * making the app wait minutes -- the remaining chapters simply carry no
     * date, which beats a wrong one.
     */
    async getChapters(mangaId: string): Promise<Chapter[]> {
        if (!isSeriesId(mangaId)) {
            const gallery = await this.gallery(mangaId)
            if ((gallery.tags ?? []).some((tag) => BANNED_IDS.has(tag.id))) {
                throw new Error('This gallery carries content excluded by your settings (BL/yaoi, ugly bastard or bald) and will not be shown.')
            }

            return [App.createChapter({
                id: String(gallery.id),
                chapNum: 1,
                name: (gallery.title?.pretty ?? gallery.title?.english ?? 'Gallery').trim(),
                time: gallery.upload_date != undefined ? new Date(gallery.upload_date * 1000) : undefined,
                langCode: '🇬🇧',
                sortingIndex: 0
            })]
        }

        const base = baseFromSeriesId(mangaId)
        const volumes = await this.volumesOf(base)
        if (volumes.length === 0) {
            throw new Error(`No volumes found for "${base}".`)
        }

        // Dates are taken only from gallery records already in hand -- opening
        // an entry fetches the first volume's record for its details, so that
        // one is dated for free. Fetching the rest would cost a request per
        // volume against a fifteen-a-minute budget, which is what made the
        // source unusable; a missing date beats an entry that never loads.
        const times: Record<number, Date | undefined> = {}
        for (const volume of volumes) {
            const cached = this.remembered<ApiGallery>(`g:${volume.id}`)
            if (cached?.upload_date != undefined) times[volume.id] = new Date(cached.upload_date * 1000)
        }

        return volumes.map((volume, index) => App.createChapter({
            id: String(volume.id),
            chapNum: volume.volume,
            name: volume.title,
            time: times[volume.id],
            langCode: '🇬🇧',
            sortingIndex: index
        }))
    }

    /**
     * The chapter id is the gallery to read. `gallery` is accepted as well,
     * the id the source handed out before volumes were merged, so an entry
     * already in the library keeps working.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const galleryId = /^\d+$/.test(chapterId) ? chapterId : String(await this.representativeId(mangaId))
        const gallery = await this.gallery(galleryId)

        const pages: string[] = []
        for (const page of gallery.pages ?? []) {
            const path = (page.path ?? '').replace(/^\/+/, '')
            if (path.length > 0) pages.push(`${NH_IMAGE_CDN}/${path}`)
        }

        if (pages.length === 0) {
            throw new Error(`No pages were returned for gallery ${galleryId}.`)
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

        // A typed query rides on the API's full syntax, so hand-written
        // `artist:x` or `tag:y` terms keep working; the exclusions are
        // appended either way. A bare language selection browses that
        // language; no selection browses English.
        const language = LANGUAGES.find((entry) => entry.id === selected)?.id ?? 'english'
        const q = title.length > 0 ? title : `language:${language}`

        return this.pagedSearch(q, 'date', page, seen)
    }

    /** The exclusions are fixed by design, so exclusion is not offered. */
    async supportsTagExclusion(): Promise<boolean> {
        return false
    }

    async getSearchTags(): Promise<TagSection[]> {
        return [
            App.createTagSection({
                id: 'language',
                label: 'Language',
                tags: LANGUAGES.map((entry) => App.createTag({ id: entry.id, label: entry.label }))
            }),
            // Shown so the standing exclusions are visible in the filter UI;
            // selecting one cannot bring the content back.
            App.createTagSection({
                id: 'excluded',
                label: 'Always Excluded',
                tags: NH_BANNED.map((tag) => App.createTag({ id: `x-${tag.id}`, label: `No ${tag.name}` }))
            })
        ]
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

            const data = await this.fetchJson<{ result?: ApiListing[] }>(this.searchUrl('language:english', entry.sort, 1))
            section.items = this.tilesFrom(data.result ?? [], new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        const sort = SECTIONS.find((entry) => entry.id === homepageSectionId)?.sort ?? 'date'
        return this.pagedSearch('language:english', sort, page, seen)
    }
}
