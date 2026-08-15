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
    cookiesFromHeaders,
    FM_DOMAIN,
    FM_TYPES,
    isLastPage,
    parseChapters,
    parseImagePayload,
    parseMangaDetails,
    parseReaderHandle,
    parseTiles
} from './FullManhwaParser'

export const FullManhwaInfo: SourceInfo = {
    version: '1.1.0',
    name: 'FullManhwa',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from fullmanhwa.com.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: FM_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class FullManhwa implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${FM_DOMAIN}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }

                // Carry any session the user established in the WebView, so
                // account-locked chapters are visible. Merged with, rather than
                // replacing, cookies a caller already set.
                const stored = this.storedCookies()
                if (stored.length > 0) {
                    const existing = (request.headers['cookie'] ?? '').trim()
                    request.headers['cookie'] = existing.length > 0 ? `${stored}; ${existing}` : stored
                }

                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    getMangaShareUrl(mangaId: string): string {
        return `${FM_DOMAIN}/manga/${mangaId}`
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
            if (domain.length > 0 && !FM_DOMAIN.includes(domain)) continue
            if (cookie.name) parts.push(`${cookie.name}=${cookie.value}`)
        }
        return parts.join('; ')
    }

    /**
     * Opens the login page rather than the homepage. The same WebView both
     * clears the Cloudflare challenge and lets the user sign in, and the
     * session it leaves behind unlocks account-gated chapters.
     */
    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${FM_DOMAIN}/login`,
            method: 'GET',
            headers: {
                'referer': `${FM_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkCloudflare(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${FullManhwaInfo.name}> and press the cloud icon.`)
        }
    }

    private async fetch(url: string, headers?: Record<string, string>): Promise<Response> {
        const request = App.createRequest({ url: url, method: 'GET', headers: headers })
        const response = await this.requestManager.schedule(request, 1)
        this.checkCloudflare(response.status)
        return response
    }

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        return cheerio.load((await this.fetch(url)).data as string)
    }

    private listingUrl(type: string, page: number): string {
        return `${FM_DOMAIN}/type/${type}?page=${page}`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        return parseMangaDetails(await this.loadPage(this.getMangaShareUrl(mangaId)), mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        return parseChapters(await this.loadPage(this.getMangaShareUrl(mangaId)))
    }

    /**
     * Pages are not in the chapter HTML. The page carries a token for
     * /api/reader_images.php, but the token is only accepted alongside the
     * session cookie that same response set -- with the token alone the API
     * answers `invalid_token`. So the cookie is captured and replayed here.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const chapterUrl = `${FM_DOMAIN}/manga/${mangaId}/${chapterId}`
        const page = await this.fetch(chapterUrl)

        const handle = parseReaderHandle(page.data as string)
        if (handle == undefined) {
            throw new Error(`Could not find the reader token for ${mangaId}/${chapterId}.`)
        }

        const cookie = cookiesFromHeaders(page.headers ?? {})
        const apiUrl = `${FM_DOMAIN}${handle.endpoint}?token=${encodeURIComponent(handle.token)}&lang=${encodeURIComponent(handle.lang)}`

        const headers: Record<string, string> = {
            'referer': chapterUrl,
            'x-requested-with': 'XMLHttpRequest',
            'cache-control': 'no-cache'
        }
        if (cookie.length > 0) headers['cookie'] = cookie

        const pages = parseImagePayload((await this.fetch(apiUrl, headers)).data as string)
        if (pages.length === 0) {
            throw new Error(`No pages were returned for ${mangaId}/${chapterId}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    async getSearchResults(query: SearchRequest, metadata: { page?: number } | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const type = (query.includedTags ?? [])[0]?.id

        // Titles go through search; a bare type selection browses that listing.
        const url = query.title
            ? `${FM_DOMAIN}/search?q=${encodeURIComponent(query.title)}&page=${page}`
            : this.listingUrl(type ?? 'manhwa', page)

        const tiles = parseTiles(await this.loadPage(url))

        return App.createPagedResults({
            results: tiles,
            metadata: isLastPage(tiles) ? undefined : { page: page + 1 }
        })
    }

    /** The site offers no way to exclude a type, so exclusion is not claimed. */
    async supportsTagExclusion(): Promise<boolean> {
        return false
    }

    async getSearchTags(): Promise<TagSection[]> {
        return [
            App.createTagSection({
                id: 'type',
                label: 'Type',
                tags: FM_TYPES.map((type) => App.createTag({ id: type.id, label: type.label }))
            })
        ]
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // Reported once each, only after items are attached: a section with an
        // unset `items` crashes the app when it reads the list.
        for (const type of FM_TYPES) {
            const section = App.createHomeSection({
                id: type.id,
                title: type.label,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: true,
                items: []
            })

            section.items = parseTiles(await this.loadPage(this.listingUrl(type.id, 1)))
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: { page?: number } | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const tiles = parseTiles(await this.loadPage(this.listingUrl(homepageSectionId, page)))

        return App.createPagedResults({
            results: tiles,
            metadata: isLastPage(tiles) ? undefined : { page: page + 1 }
        })
    }
}
