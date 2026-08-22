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
    isLastPage,
    parseChapters,
    parseGenres,
    parseMangaDetails,
    parsePages,
    parseTiles,
    routeFor,
    SM_BASE,
    SM_HIDDEN_COOKIE,
    SM_DOMAIN,
    SM_ORIGINS,
    SM_SECTIONS,
    TileRow
} from './FullManhwaParser'

/**
 * The source keeps its FullManhwa identity on purpose. Paperback keys a user's
 * library, reading progress and downloads on the bundle id, which comes from
 * this directory name -- renaming it would orphan every entry. fullmanhwa.com
 * simply became saymanhwa.com, and the slugs that survived the move still
 * resolve, so the existing library keeps working.
 */
export const FullManhwaInfo: SourceInfo = {
    version: '2.3.0',
    name: 'SayManhwa',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from saymanhwa.com, the successor to fullmanhwa.com.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: SM_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

/**
 * Listings are paged by `?page=`, and the ids already handed out travel along so
 * a later page can drop anything the app has seen. That is what keeps an
 * infinite scroll from repeating titles when the site reorders a listing between
 * requests -- `/latest` reshuffles as chapters land.
 */
interface ListingMetadata {
    page?: number
    seen?: string[]
}

export class FullManhwa implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        // The sites answer slowly under the sustained load of a whole-library
        // refresh -- saymanhwa was measured at a 7s ninetieth percentile and a
        // 20s worst case -- so a thirty second ceiling turned slow-but-fine
        // responses into refresh failures.
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${SM_BASE}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }

                // Carry any session the user established in the WebView, so
                // account-locked chapters are visible. Merged with, rather than
                // replacing, cookies a caller already set. The hide-BL
                // preference cookie leads so the server filters every listing.
                const stored = [SM_HIDDEN_COOKIE, this.storedCookies()]
                    .filter((part) => part.length > 0)
                    .join('; ')
                const existing = (request.headers['cookie'] ?? '').trim()
                request.headers['cookie'] = existing.length > 0 ? `${stored}; ${existing}` : stored

                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    getMangaShareUrl(mangaId: string): string {
        return `${SM_BASE}/series/${mangaId}`
    }

    /**
     * Cookies the app holds for this site, including whatever the WebView
     * picked up when the user signed in.
     */
    private storedCookies(): string {
        const cookies = this.requestManager.cookieStore?.getAllCookies() ?? []

        const parts: string[] = []
        for (const cookie of cookies) {
            const domain = (cookie.domain ?? '').replace(/^\./, '')
            if (domain.length > 0 && !SM_DOMAIN.includes(domain)) continue
            if (cookie.name) parts.push(`${cookie.name}=${cookie.value}`)
        }
        return parts.join('; ')
    }

    /**
     * Opens the login page rather than the homepage. The same WebView both
     * clears the Cloudflare challenge and lets the user sign in, and the
     * session it leaves behind unlocks anything the site puts behind VIP.
     */
    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${SM_BASE}/login`,
            method: 'GET',
            headers: {
                'referer': `${SM_BASE}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkCloudflare(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${FullManhwaInfo.name}> and press the cloud icon.`)
        }
        // A 5xx answer is an error page, not content. Without this it was
        // parsed anyway, and a Cloudflare "Error code 520" notice ended up
        // shown as the title of a series.
        if (status >= 500) {
            throw new Error(`The site returned an error (HTTP ${status}). It is probably down or overloaded -- try again shortly.`)
        }

        if (status < 200 || status >= 300) {
            throw new Error(`Unexpected response from the site (HTTP ${status}).`)
        }
    }

    private async fetch(url: string, headers?: Record<string, string>): Promise<Response> {
        const request = App.createRequest({ url: url, method: 'GET', headers: headers })
        const response = await this.requestManager.schedule(request, 3)
        this.checkCloudflare(response.status)
        return response
    }

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        return cheerio.load((await this.fetch(url)).data as string)
    }

    private listingUrl(id: string, page: number): string {
        return `${SM_BASE}${routeFor(id)}?page=${page}`
    }

    /**
     * Turns parsed rows into tiles, dropping ids the app already holds.
     *
     * The tiles are built here from plain rows rather than read back out of a
     * created PartialSourceManga: the local harnesses stub the App factories as
     * identity functions, so anything read off a created object round-trips
     * off-device and then silently fails on the phone.
     */
    private tilesFrom(rows: TileRow[], seen: Set<string>): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []

        for (const row of rows) {
            if (seen.has(row.slug)) continue
            seen.add(row.slug)

            tiles.push(App.createPartialSourceManga({
                mangaId: row.slug,
                image: row.image,
                title: row.title
            }))
        }

        return tiles
    }

    /**
     * Walks one page of a listing and works out whether to offer another. Paging
     * stops on a short page, and also when a full page contributed nothing new,
     * which is what a reordered listing looks like from here.
     */
    /**
     * Walks a listing from `page` until something qualifies or it ends,
     * returning plain data -- results are never read back off a created
     * PagedResults, which round-trips off-device and fails on the phone.
     *
     * The walk exists because the BL rule can empty a page the site itself
     * filled -- the latest feed has run ten BL cards of twenty-four and the
     * completed listing a full page -- and handing the app an empty batch
     * risks stalling its scroll.
     */
    private async walkListing(urlFor: (page: number) => string, page: number, seen: Set<string>): Promise<{ tiles: PartialSourceManga[]; nextPage?: number }> {
        const tiles: PartialSourceManga[] = []
        let current = page

        for (let hop = 0; hop < 4; hop++) {
            const $ = await this.loadPage(urlFor(current))
            const rows = parseTiles($)
            tiles.push(...this.tilesFrom(rows, seen))

            if (isLastPage($)) return { tiles }
            // A full page whose survivors were all already handed out is the
            // reordering-listing signature; stopping there is what keeps an
            // infinite scroll from looping. An all-BL page (no survivors at
            // all) is not that -- the walk continues past it.
            if (rows.length > 0 && tiles.length === 0) return { tiles }

            current++
            if (tiles.length > 0) break
        }

        return { tiles, nextPage: current }
    }

    private async pagedListing(urlFor: (page: number) => string, page: number, seen: Set<string>): Promise<PagedResults> {
        const walk = await this.walkListing(urlFor, page, seen)

        return App.createPagedResults({
            results: walk.tiles,
            metadata: walk.nextPage == undefined ? undefined : { page: walk.nextPage, seen: Array.from(seen) }
        })
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        return parseMangaDetails(await this.loadPage(this.getMangaShareUrl(mangaId)), mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        return parseChapters(await this.loadPage(this.getMangaShareUrl(mangaId)))
    }

    /**
     * Pages come straight out of the chapter HTML now. The rebuilt reader
     * dropped the token handshake the old site used, so there is no second
     * request and no session to replay -- the images are plain <img> tags.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const pages = parsePages(await this.loadPage(`${SM_BASE}/series/${mangaId}/${chapterId}`))

        if (pages.length === 0) {
            throw new Error(`No pages were found for ${mangaId}/${chapterId}. The chapter may be VIP-only -- press the cloud icon on the source homepage and sign in.`)
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

        // A title goes through the catalog's own `q`; a bare tag selection
        // browses that listing instead.
        const urlFor = title.length > 0
            ? (p: number) => `${SM_BASE}/series?q=${encodeURIComponent(title)}&page=${p}`
            : (p: number) => this.listingUrl(selected ?? 'latest', p)

        return this.pagedListing(urlFor, page, seen)
    }

    /** The site offers no way to exclude a genre, so exclusion is not claimed. */
    async supportsTagExclusion(): Promise<boolean> {
        return false
    }

    /**
     * The genre list is read off the catalog filter rather than hardcoded, so it
     * tracks the site. If that request fails the browse and origin filters are
     * still offered rather than leaving the user with no filters at all.
     */
    async getSearchTags(): Promise<TagSection[]> {
        const sections: TagSection[] = [
            App.createTagSection({
                id: 'browse',
                label: 'Browse',
                tags: SM_SECTIONS.map((entry) => App.createTag({ id: entry.id, label: entry.label }))
            }),
            App.createTagSection({
                id: 'origin',
                label: 'Type',
                tags: SM_ORIGINS.map((entry) => App.createTag({ id: entry.id, label: entry.label }))
            })
        ]

        try {
            const genres = parseGenres(await this.loadPage(`${SM_BASE}/latest`))
            if (genres.length > 0) {
                sections.push(App.createTagSection({
                    id: 'genre',
                    label: 'Genre',
                    tags: genres
                        .sort((a, b) => a.label.localeCompare(b.label))
                        .map((genre) => App.createTag({ id: genre.id, label: genre.label }))
                }))
            }
        } catch {
            // Leaves the static sections in place.
        }

        return sections
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // Reported once each, only after items are attached: a section with an
        // unset `items` crashes the app when it reads the list.
        for (const entry of SM_SECTIONS) {
            const section = App.createHomeSection({
                id: entry.id,
                title: entry.label,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: true,
                items: []
            })

            const walk = await this.walkListing((p) => this.listingUrl(entry.id, p), 1, new Set<string>())
            section.items = walk.tiles
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        return this.pagedListing((p) => this.listingUrl(homepageSectionId, p), page, seen)
    }
}
