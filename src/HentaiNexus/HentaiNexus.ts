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

import { decodeReaderPayload } from './HentaiNexusDecoder'

import {
    baseFromSeriesId,
    CATEGORIES,
    chaptersFromVolumes,
    extractReaderPayload,
    groupIntoSeries,
    HN_DOMAIN,
    isLastPage,
    isSeriesId,
    parseCards,
    parseCategoryTags,
    parseChapters,
    parseMangaDetails,
    seriesQuery,
    toSearchTerm,
    volumesOf,
    type SeriesVolume
} from './HentaiNexusParser'

export const HentaiNexusInfo: SourceInfo = {
    version: '1.3.0',
    name: 'HentaiNexus',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from hentainexus.com. Numbered volumes of a series are merged into one entry.',
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
        // A merged series has no single gallery page, so share its search instead.
        return isSeriesId(mangaId)
            ? `${HN_DOMAIN}/?q=${encodeURIComponent(seriesQuery(baseFromSeriesId(mangaId)))}`
            : `${HN_DOMAIN}/view/${mangaId}`
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

    private async fetchHtml(url: string): Promise<string> {
        const request = App.createRequest({ url: url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 1)
        this.checkCloudflare(response.status)
        return response.data as string
    }

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        return cheerio.load(await this.fetchHtml(url))
    }

    /** Every listing surface paginates as `/page/{n}`, with filters carried in `?q=`. */
    private listingUrl(page: number, query?: string): string {
        const search = query ? `?q=${encodeURIComponent(query)}` : ''
        return `${HN_DOMAIN}/page/${page}${search}`
    }

    /**
     * Finds a series' volumes by searching its base title. One page is enough;
     * a series running past 30 volumes would be extraordinary here.
     */
    private async fetchVolumes(base: string): Promise<SeriesVolume[]> {
        const $ = await this.loadPage(this.listingUrl(1, seriesQuery(base)))
        return volumesOf(parseCards($), base)
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        if (!isSeriesId(mangaId)) {
            const $ = await this.loadPage(`${HN_DOMAIN}/view/${mangaId}`)
            return parseMangaDetails($, mangaId)
        }

        const base = baseFromSeriesId(mangaId)
        const volumes = await this.fetchVolumes(base)
        if (volumes.length === 0) {
            throw new Error(`No volumes found for "${base}".`)
        }

        // The first volume supplies the cover, artist and tags for the series.
        const $ = await this.loadPage(`${HN_DOMAIN}/view/${(volumes[0] as SeriesVolume).id}`)
        return parseMangaDetails($, mangaId, base, volumes.length)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        if (!isSeriesId(mangaId)) {
            const $ = await this.loadPage(`${HN_DOMAIN}/view/${mangaId}`)
            return parseChapters($, mangaId)
        }

        return chaptersFromVolumes(await this.fetchVolumes(baseFromSeriesId(mangaId)))
    }

    /** Chapter ids are always gallery ids, merged series or not. */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const html = await this.fetchHtml(`${HN_DOMAIN}/read/${chapterId}`)
        const entries = decodeReaderPayload(extractReaderPayload(html))

        const pages: string[] = []
        for (const entry of entries) {
            if (entry.type !== 'image') continue
            // The JPEG/PNG fallback renders everywhere; AVIF does not on older iOS.
            const url = entry.image_fallback || entry.image_avif
            if (url) pages.push(url)
        }

        if (pages.length === 0) {
            throw new Error(`No pages were decoded for gallery ${chapterId}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    async getSearchResults(query: SearchRequest, metadata: { page?: number } | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1

        // Selected filters become the site's own `prefix:value` terms, with a
        // leading minus for exclusions. A typed query passes straight through,
        // so hand-written syntax like `artist:NaPaTa` still works.
        const terms: string[] = []
        if (query.title) terms.push(query.title)
        for (const tag of query.includedTags ?? []) {
            terms.push(toSearchTerm(tag.id, false))
        }
        for (const tag of query.excludedTags ?? []) {
            terms.push(toSearchTerm(tag.id, true))
        }

        const cards = parseCards(await this.loadPage(this.listingUrl(page, terms.join(' '))))

        return App.createPagedResults({
            results: groupIntoSeries(cards),
            // Paging is judged on raw cards; grouping shrinks the visible count.
            metadata: isLastPage(cards) ? undefined : { page: page + 1 }
        })
    }

    /** Lets the filter screen offer exclusions, not just inclusions. */
    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    /**
     * Every filterable category the site publishes, so tags, artists, circles,
     * parodies, magazines, publishers and events can all be picked from the
     * search filter rather than typed by hand.
     */
    async getSearchTags(): Promise<TagSection[]> {
        const sections: TagSection[] = []

        for (const category of CATEGORIES) {
            const $ = await this.loadPage(`${HN_DOMAIN}/explore/categories/${category.prefix}`)
            const tags = parseCategoryTags($, category.prefix)
            if (tags.length === 0) continue

            sections.push(App.createTagSection({
                id: category.prefix,
                label: category.label,
                tags: tags
            }))
        }

        return sections
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
            section.items = groupIntoSeries(parseCards(await this.loadPage(url)))
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: { page?: number } | undefined): Promise<PagedResults> {
        if (homepageSectionId !== SECTION_NEW) {
            return App.createPagedResults({ results: [] })
        }

        const page = metadata?.page ?? 1
        const cards = parseCards(await this.loadPage(this.listingUrl(page)))

        return App.createPagedResults({
            results: groupIntoSeries(cards),
            metadata: isLastPage(cards) ? undefined : { page: page + 1 }
        })
    }
}
