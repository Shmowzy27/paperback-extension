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
    filterTrack,
    isLastPage,
    MC_DOMAIN,
    parseChapters,
    parseGenres,
    parseMangaDetails,
    parseMangaPostId,
    parsePages,
    parseTiles
} from './ManhwaClubParser'

export const ManhwaClubInfo: SourceInfo = {
    version: '2.5.0',
    name: 'ManhwaClub (English)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from manhwaclub.net.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: MC_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

const SECTION_LATEST = 'latest'
const SECTION_TRENDING = 'trending'
const SECTION_NEW = 'new-manga'

export class ManhwaClub implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
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
                        'referer': `${MC_DOMAIN}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }

                // Carry any session the user established in the WebView, so
                // account-locked chapters are visible.
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
        return `${MC_DOMAIN}/manga/${mangaId}/`
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
            if (domain.length > 0 && !MC_DOMAIN.includes(domain)) continue
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
            url: `${MC_DOMAIN}/wp-login.php`,
            method: 'GET',
            headers: {
                'referer': `${MC_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkCloudflare(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${ManhwaClubInfo.name}> and press the cloud icon.`)
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

    private async fetchHtml(url: string): Promise<string> {
        const request = App.createRequest({ url: url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 3)
        this.checkCloudflare(response.status)
        return response.data as string
    }

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        return cheerio.load(await this.fetchHtml(url))
    }

    /**
     * Madara paginates as `/manga/page/{n}/?m_orderby=…`, but page 1 only
     * resolves through a redirect, so it is requested directly.
     */
    private listingUrl(order: string, page: number): string {
        return page <= 1
            ? `${MC_DOMAIN}/manga/?m_orderby=${order}`
            : `${MC_DOMAIN}/manga/page/${page}/?m_orderby=${order}`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const $ = await this.loadPage(this.getMangaShareUrl(mangaId))
        return parseMangaDetails($, mangaId)
    }

    /**
     * The series page ships only a placeholder list; the real chapters come
     * from admin-ajax keyed on the numeric post id embedded in that page.
     */
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const html = await this.fetchHtml(this.getMangaShareUrl(mangaId))

        const postId = parseMangaPostId(html)
        if (postId == undefined) {
            // Fall back to whatever the page itself lists.
            return filterTrack(parseChapters(cheerio.load(html), mangaId), 'Translated')
        }

        const request = App.createRequest({
            url: `${MC_DOMAIN}/wp-admin/admin-ajax.php`,
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-requested-with': 'XMLHttpRequest',
                'referer': this.getMangaShareUrl(mangaId)
            },
            data: `action=manga_get_chapters&manga=${postId}`
        })

        const response = await this.requestManager.schedule(request, 3)
        this.checkCloudflare(response.status)

        return filterTrack(parseChapters(cheerio.load(response.data as string), mangaId), 'Translated')
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const $ = await this.loadPage(`${MC_DOMAIN}/manga/${mangaId}/${chapterId}/`)
        const pages = parsePages($)

        if (pages.length === 0) {
            throw new Error(`No pages found for ${mangaId}/${chapterId}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    /**
     * Madara filters genres through the taxonomy archive, which takes a single
     * genre and offers no exclusion, so only one included genre is honoured.
     */
    async getSearchResults(query: SearchRequest, metadata: { page?: number } | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const genre = (query.includedTags ?? [])[0]?.id

        const url = genre != undefined && !query.title
            ? `${MC_DOMAIN}/manga-genre/${genre}/page/${page}/`
            : `${MC_DOMAIN}/page/${page}/?s=${encodeURIComponent(query.title ?? '')}&post_type=wp-manga${genre != undefined ? `&genre[]=${encodeURIComponent(genre)}` : ''}`

        const tiles = parseTiles(await this.loadPage(url))

        return App.createPagedResults({
            results: tiles,
            metadata: isLastPage(tiles) ? undefined : { page: page + 1 }
        })
    }

    /**
     * The site's genre archives take one genre and cannot exclude, so the
     * filter screen is offered without exclusion rather than pretending.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return false
    }

    async getSearchTags(): Promise<TagSection[]> {
        const $ = await this.loadPage(`${MC_DOMAIN}/manga/?m_orderby=latest`)
        const tags = parseGenres($)

        return tags.length > 0
            ? [App.createTagSection({ id: 'genres', label: 'Genres', tags: tags })]
            : []
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const sections = [
            { id: SECTION_LATEST, title: 'Latest Updates', order: 'latest' },
            { id: SECTION_TRENDING, title: 'Trending', order: 'trending' },
            { id: SECTION_NEW, title: 'New Series', order: 'new-manga' }
        ]

        // Reported once each, only after items are attached: a section with an
        // unset `items` crashes the app when it reads the list.
        for (const entry of sections) {
            const section = App.createHomeSection({
                id: entry.id,
                title: entry.title,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: true,
                items: []
            })

            section.items = parseTiles(await this.loadPage(this.listingUrl(entry.order, 1)))
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
