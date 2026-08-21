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
 * nhentai through its own v2 JSON API. One gallery is one manga carrying a
 * single chapter, the same shape HentaiNexus uses for standalone galleries.
 *
 * Excluded by construction: the standing BL/yaoi rule plus ugly bastard and
 * bald, negated inside every search query so the server filters, and every
 * returned entry re-checked against the banned tag ids as the backstop.
 */
export const NHentaiInfo: SourceInfo = {
    version: '1.0.0',
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
        // The API allows 15 requests a minute anonymously and answers 429
        // beyond it, so the source paces itself well inside that.
        requestsPerSecond: 0.2,
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

    getMangaShareUrl(mangaId: string): string {
        return `${NH_DOMAIN}/g/${mangaId}/`
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

    private async fetchJson<T>(url: string): Promise<T> {
        const request = App.createRequest({ url: url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 3)
        this.checkResponse(response.status)
        return JSON.parse(response.data as string) as T
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

    private tilesFrom(entries: ApiListing[], seen: Set<string>): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []

        for (const entry of entries) {
            const id = String(entry.id)
            if (seen.has(id) || !this.admitted(entry.tag_ids)) continue

            const title = (entry.english_title ?? entry.japanese_title ?? `Gallery ${id}`).trim()
            const thumb = (entry.thumbnail ?? '').replace(/^\/+/, '')

            seen.add(id)
            tiles.push(App.createPartialSourceManga({
                mangaId: id,
                image: thumb.length > 0 ? `${NH_THUMB_CDN}/${thumb}` : '',
                title: title
            }))
        }

        return tiles
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

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const gallery = await this.fetchJson<ApiGallery>(`${NH_API}/galleries/${mangaId}`)

        const tags = gallery.tags ?? []
        const title = (gallery.title?.pretty ?? gallery.title?.english ?? `Gallery ${mangaId}`).trim()
        const fullTitle = (gallery.title?.english ?? title).trim()

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
     * A gallery is a single chapter. Built directly from the gallery payload;
     * upload_date is epoch seconds.
     */
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const gallery = await this.fetchJson<ApiGallery>(`${NH_API}/galleries/${mangaId}`)

        if ((gallery.tags ?? []).some((tag) => BANNED_IDS.has(tag.id))) {
            throw new Error('This gallery carries content excluded by your settings (BL/yaoi, ugly bastard or bald) and will not be shown.')
        }

        const uploaded = gallery.upload_date != undefined ? new Date(gallery.upload_date * 1000) : undefined

        return [App.createChapter({
            id: 'gallery',
            chapNum: 1,
            name: (gallery.title?.pretty ?? gallery.title?.english ?? 'Gallery').trim(),
            time: uploaded,
            langCode: '🇬🇧',
            sortingIndex: 0
        })]
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const gallery = await this.fetchJson<ApiGallery>(`${NH_API}/galleries/${mangaId}`)

        const pages: string[] = []
        for (const page of gallery.pages ?? []) {
            const path = (page.path ?? '').replace(/^\/+/, '')
            if (path.length > 0) pages.push(`${NH_IMAGE_CDN}/${path}`)
        }

        if (pages.length === 0) {
            throw new Error(`No pages were returned for gallery ${mangaId}.`)
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
