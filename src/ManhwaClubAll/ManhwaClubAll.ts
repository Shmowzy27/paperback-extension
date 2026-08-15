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

// The site is identical for both tracks, so the parser is shared with the
// English source rather than duplicated.
import {
    isLastPage,
    MC_DOMAIN,
    parseChapters,
    parseGenres,
    parseMangaDetails,
    parseMangaPostId,
    parsePages,
    parseTiles
} from '../ManhwaClub/ManhwaClubParser'

/**
 * Both release tracks of manhwaclub.net in a single source.
 *
 * The English and Raw sources exist so the two tracks can be kept apart, but
 * merging them in the library is a manual, per-title action in Paperback and an
 * extension cannot do it. This source is the alternative: every chapter of both
 * tracks arrives already combined, each row labelled Raw or Translated.
 */
export const ManhwaClubAllInfo: SourceInfo = {
    version: '1.4.0',
    name: 'ManhwaClub (All)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Translated and raw releases from manhwaclub.net in one list, no merging needed. Use the English or Raw sources instead to keep the tracks separate.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: MC_DOMAIN,
    sourceTags: [
        {
            text: 'EN+RAW',
            type: BadgeColor.GREEN
        },
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

export class ManhwaClubAll implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 30000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${MC_DOMAIN}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }

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

    /** Cookies the app holds for this site, including a WebView sign-in. */
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
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${ManhwaClubAllInfo.name}> and press the cloud icon.`)
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
        const response = await this.requestManager.schedule(request, 1)
        this.checkCloudflare(response.status)
        return response.data as string
    }

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        return cheerio.load(await this.fetchHtml(url))
    }

    private listingUrl(order: string, page: number): string {
        return page <= 1
            ? `${MC_DOMAIN}/manga/?m_orderby=${order}`
            : `${MC_DOMAIN}/manga/page/${page}/?m_orderby=${order}`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        return parseMangaDetails(await this.loadPage(this.getMangaShareUrl(mangaId)), mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const html = await this.fetchHtml(this.getMangaShareUrl(mangaId))

        const postId = parseMangaPostId(html)
        if (postId == undefined) {
            return parseChapters(cheerio.load(html), mangaId)
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

        const response = await this.requestManager.schedule(request, 1)
        this.checkCloudflare(response.status)

        return parseChapters(cheerio.load(response.data as string), mangaId)
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const pages = parsePages(await this.loadPage(`${MC_DOMAIN}/manga/${mangaId}/${chapterId}/`))

        if (pages.length === 0) {
            throw new Error(`No pages found for ${mangaId}/${chapterId}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

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

    async supportsTagExclusion(): Promise<boolean> {
        return false
    }

    async getSearchTags(): Promise<TagSection[]> {
        const tags = parseGenres(await this.loadPage(`${MC_DOMAIN}/manga/?m_orderby=latest`))

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
