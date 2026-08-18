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
    TagSection
} from '@paperback/types'

import * as cheerio from 'cheerio'

import {
    countCards,
    filteredListingUrl,
    isLastPage,
    MK_BANNED,
    MK_DOMAIN,
    MK_WANTED,
    parseChapters,
    parseMangaDetails,
    parsePages,
    parseTiles,
    searchUrl,
    TileRow
} from './MangaKatanaParser'

/**
 * mangakatana.com, restricted to 18+ content by construction: every listing
 * runs through the site's own genre filter (any of adult, ecchi, erotica,
 * sexual violence; never gender bender, yaoi or shounen-ai), and every card is
 * re-checked against the same rule client-side, so search cannot leak
 * unfiltered titles either. Format is deliberately not restricted -- manga,
 * manhwa, manhua and webtoon all qualify so long as the genres do.
 */
export const MangaKatanaInfo: SourceInfo = {
    version: '1.0.0',
    name: 'MangaKatana (18+)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls 18+ content from mangakatana.com.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: MK_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

const SECTIONS: { id: string; label: string; order: string }[] = [
    { id: 'latest', label: 'Latest Updates (18+)', order: 'latest' },
    { id: 'new', label: 'New Titles (18+)', order: 'new' },
    { id: 'chapters', label: 'Most Chapters (18+)', order: 'numc' }
]

/**
 * Listings carry the ids already handed out so a later page can drop anything
 * the app has seen -- the latest-ordered listing reshuffles as chapters land,
 * and without this a series straddling a page boundary shows twice.
 */
interface ListingMetadata {
    page?: number
    seen?: string[]
}

export class MangaKatana implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        // The site drops connections outright under bursts rather than
        // answering 429, and the sibling sources have already shown that a
        // tight ceiling turns slow-but-fine responses into refresh failures.
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${MK_DOMAIN}/`,
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
        return `${MK_DOMAIN}/manga/${mangaId}`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${MK_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${MK_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${MangaKatanaInfo.name}> and press the cloud icon.`)
        }
        // A 5xx answer is an error page, not content; parsing one has
        // previously surfaced a Cloudflare notice as a series title.
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

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        return cheerio.load(await this.fetchHtml(url))
    }

    /**
     * Tiles are built here from plain rows rather than read back off created
     * objects: the local harnesses stub the App factories as identity
     * functions, so a field read back round-trips off-device and then silently
     * fails on the phone.
     */
    private tilesFrom(rows: TileRow[], seen: Set<string>): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []

        for (const row of rows) {
            if (seen.has(row.mangaId)) continue
            seen.add(row.mangaId)

            tiles.push(App.createPartialSourceManga({
                mangaId: row.mangaId,
                image: row.image,
                title: row.title
            }))
        }

        return tiles
    }

    /**
     * One page of a listing. Whether to offer another page is judged on the
     * raw card count, not the admitted tiles: the 18+ rule can empty a page
     * that the site itself filled, and search pages especially may need
     * several fetches before anything qualifies.
     */
    private async pagedListing(url: string, page: number, seen: Set<string>): Promise<PagedResults> {
        const $ = await this.loadPage(url)
        const tiles = this.tilesFrom(parseTiles($), seen)

        const exhausted = isLastPage($) || (countCards($) > 0 && tiles.length === 0 && page > 50)

        return App.createPagedResults({
            results: tiles,
            metadata: exhausted ? undefined : { page: page + 1, seen: Array.from(seen) }
        })
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        return parseMangaDetails(await this.loadPage(this.getMangaShareUrl(mangaId)), mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        return parseChapters(await this.loadPage(this.getMangaShareUrl(mangaId)))
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const pages = parsePages(await this.fetchHtml(`${MK_DOMAIN}/manga/${mangaId}/${chapterId}`))

        if (pages.length === 0) {
            throw new Error(`No pages were found for ${mangaId}/${chapterId}.`)
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

        // A typed title goes through the site's text search, whose results are
        // then re-checked against the 18+ rule card by card -- the search
        // endpoint itself cannot filter by genre. A bare tag selection browses
        // the filtered listing for that genre instead.
        if (title.length > 0) {
            return this.pagedListing(searchUrl(title, page), page, seen)
        }

        const wanted = MK_WANTED.find((genre) => genre.slug === selected)
        const url = wanted != undefined
            ? filteredListingUrl('latest', page, [wanted.slug])
            : filteredListingUrl('latest', page)

        return this.pagedListing(url, page, seen)
    }

    /** The exclusions are fixed by design, so exclusion is not offered. */
    async supportsTagExclusion(): Promise<boolean> {
        return false
    }

    async getSearchTags(): Promise<TagSection[]> {
        return [
            App.createTagSection({
                id: 'genre',
                label: '18+ Genres',
                tags: MK_WANTED.map((genre) => App.createTag({ id: genre.slug, label: genre.label }))
            }),
            // Shown so the exclusions are visible in the filter UI; selecting
            // one still cannot bring the excluded content back.
            App.createTagSection({
                id: 'excluded',
                label: 'Always Excluded',
                tags: MK_BANNED.map((genre) => App.createTag({ id: `x-${genre.slug}`, label: `No ${genre.label}` }))
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

            const $ = await this.loadPage(filteredListingUrl(entry.order, 1))
            section.items = this.tilesFrom(parseTiles($), new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        const order = SECTIONS.find((entry) => entry.id === homepageSectionId)?.order ?? 'latest'
        return this.pagedListing(filteredListingUrl(order, page), page, seen)
    }
}
