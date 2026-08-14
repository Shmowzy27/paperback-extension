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
    SourceManga
} from '@paperback/types'

import * as cheerio from 'cheerio'

import { decodeReaderPayload } from './HentaiNexusDecoder'

import {
    extractReaderPayload,
    HN_DOMAIN,
    isLastPage,
    parseChapters,
    parseMangaDetails,
    parseTiles
} from './HentaiNexusParser'

export const HentaiNexusInfo: SourceInfo = {
    version: '1.0.1',
    name: 'HentaiNexus',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from hentainexus.com.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: HN_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

const SECTION_NEW = 'new'
const SECTION_POPULAR = 'popular'

export class HentaiNexus implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 15000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${HN_DOMAIN}/`,
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
        return `${HN_DOMAIN}/view/${mangaId}`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${HN_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${HN_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    /** Cloudflare answers a challenge with 403/503 rather than the page we asked for. */
    private checkCloudflare(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${HentaiNexusInfo.name}> and press the cloud icon.`)
        }
    }

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        return cheerio.load(await this.fetchHtml(url))
    }

    private async fetchHtml(url: string): Promise<string> {
        const request = App.createRequest({ url: url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 1)
        this.checkCloudflare(response.status)
        return response.data as string
    }

    /** Every listing surface paginates as `/page/{n}`, with filters carried in `?q=`. */
    private listingUrl(page: number, query?: string): string {
        const search = query ? `?q=${encodeURIComponent(query)}` : ''
        return `${HN_DOMAIN}/page/${page}${search}`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const $ = await this.loadPage(`${HN_DOMAIN}/view/${mangaId}`)
        return parseMangaDetails($, mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const $ = await this.loadPage(`${HN_DOMAIN}/view/${mangaId}`)
        return parseChapters($, mangaId)
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const html = await this.fetchHtml(`${HN_DOMAIN}/read/${mangaId}`)
        const entries = decodeReaderPayload(extractReaderPayload(html))

        const pages: string[] = []
        for (const entry of entries) {
            if (entry.type !== 'image') continue
            // The JPEG/PNG fallback renders everywhere; AVIF does not on older iOS.
            const url = entry.image_fallback || entry.image_avif
            if (url) pages.push(url)
        }

        if (pages.length === 0) {
            throw new Error(`No pages were decoded for gallery ${mangaId}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    async getSearchResults(query: SearchRequest, metadata: { page?: number } | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1

        // Included tags are folded into the site's own `tag:"…"` filter syntax,
        // and a raw query is passed straight through so `artist:…` etc. still work.
        const terms: string[] = []
        if (query.title) terms.push(query.title)
        for (const tag of query.includedTags ?? []) {
            terms.push(`tag:"${tag.id}"`)
        }

        const $ = await this.loadPage(this.listingUrl(page, terms.join(' ')))
        const tiles = parseTiles($)

        return App.createPagedResults({
            results: tiles,
            metadata: isLastPage(tiles) ? undefined : { page: page + 1 }
        })
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const sections = [
            {
                section: App.createHomeSection({
                    id: SECTION_NEW,
                    title: 'New Releases',
                    type: HomeSectionType.singleRowNormal,
                    containsMoreItems: true,
                    items: []
                }),
                url: this.listingUrl(1)
            },
            {
                section: App.createHomeSection({
                    id: SECTION_POPULAR,
                    title: 'Popular',
                    type: HomeSectionType.singleRowNormal,
                    // `/explore/hot` is a fixed, curated list of 30 that ignores any
                    // page parameter, so there is nothing more to load.
                    containsMoreItems: false,
                    items: []
                }),
                url: `${HN_DOMAIN}/explore/hot`
            }
        ]

        // Each section is reported once, and only after its items are attached.
        // Emitting a section whose `items` is still unset crashes the app with
        // "undefined is not an object" the moment it reads the list.
        for (const { section, url } of sections) {
            const $ = await this.loadPage(url)
            section.items = parseTiles($)
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: { page?: number } | undefined): Promise<PagedResults> {
        if (homepageSectionId !== SECTION_NEW) {
            return App.createPagedResults({ results: [] })
        }

        const page = metadata?.page ?? 1
        const $ = await this.loadPage(this.listingUrl(page))
        const tiles = parseTiles($)

        return App.createPagedResults({
            results: tiles,
            metadata: isLastPage(tiles) ? undefined : { page: page + 1 }
        })
    }
}
