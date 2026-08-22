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

export const HH_DOMAIN = 'https://hentaihere.com'
const HH_CDN = 'https://hentaicdn.com/hentai'

/**
 * Excluded by standing request. Yaoi is the site's category T27; the site's
 * taxonomy carries no fat, ugly bastard or bald tags, so on this site the BL
 * exclusion is the whole rule. The label list also scrubs anything matching
 * from the tag catalog offered in the filter UI.
 */
const BANNED_TAG_ID = '27'
const BANNED_LABELS = /yaoi|shounen[ -]?ai|males only|tomgirl|crossdress|ugly bastard|\bbald\b|\bfat\b/i

/** Appended to every text search; the search engine matches category names. */
const SEARCH_SUFFIX = ' -yaoi'

const SECTIONS: { id: string; label: string; sort: string }[] = [
    { id: 'newest', label: 'Newest (Filtered)', sort: 'newest' },
    { id: 'most-popular', label: 'Most Popular (Filtered)', sort: 'most-popular' },
    { id: 'last-updated', label: 'Last Updated (Filtered)', sort: 'last-updated' }
]

/**
 * Listing state carried between pages. `token` names the saved server-side
 * filter (an `sf_...` handle the site issues after the filter POST); with it,
 * every later page is a plain GET that the server has already filtered.
 */
interface ListingMetadata {
    page?: number
    token?: string
    sort?: string
    seen?: string[]
}

/**
 * hentaihere.com with the standing exclusions enforced server-side.
 *
 * The site's /filter accepts a tag exclusion (s[tagOut]) and answers with a
 * saved-filter token; browsing through that token, the server itself never
 * sends the excluded content -- 62k of the site's 66k titles survive the yaoi
 * exclusion, and pagination stays clean. Text search rides on the search
 * engine's own minus operator instead, and the details gate backstops both.
 */
export const HentaiHereInfo: SourceInfo = {
    version: '1.3.0',
    name: 'HentaiHere (Filtered)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from hentaihere.com with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: HH_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class HentaiHere implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${HH_DOMAIN}/`,
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
        return `${HH_DOMAIN}/m/${mangaId}`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${HH_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${HH_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${HentaiHereInfo.name}> and press the cloud icon.`)
        }
        if (status >= 500) {
            throw new Error(`The site returned an error (HTTP ${status}). It is probably down or overloaded -- try again shortly.`)
        }
        if (status < 200 || status >= 300) {
            throw new Error(`Unexpected response from the site (HTTP ${status}).`)
        }
    }

    private async fetchHtml(url: string, method: string = 'GET', body?: string): Promise<string> {
        const request = App.createRequest({
            url: url,
            method: method,
            data: body,
            headers: body != undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined
        })
        const response = await this.requestManager.schedule(request, 3)
        this.checkResponse(response.status)
        return response.data as string
    }

    /**
     * Registers the exclusion filter with the site and returns the first page
     * of results plus the saved-filter token found in the page's own
     * pagination links. The token's session cookie is captured by the app's
     * cookie store when the redirect lands, so later pages just work.
     */
    private async openFilter(tagIn?: string[], tagOut?: string[]): Promise<{ html: string; token?: string }> {
        // Whatever the reader chooses to leave out joins the standing
        // exclusion rather than replacing it, so yaoi can never be filtered
        // back in.
        const excluded = [BANNED_TAG_ID]
        for (const id of tagOut ?? []) {
            if (!excluded.includes(id)) excluded.push(id)
        }

        const included = (tagIn ?? []).join(',')
        const form = `action=doFilter&s%5Bseries%5D=&s%5BreleaseAct%5D=in&s%5Brelease%5D=&s%5BtagIn%5D=${encodeURIComponent(included)}&s%5BtagOut%5D=${encodeURIComponent(excluded.join(','))}`
        const html = await this.fetchHtml(`${HH_DOMAIN}/filter`, 'POST', form)
        const token = /[?&]s=(sf_[a-z0-9]+)/.exec(html)?.[1]
        return { html, token }
    }

    private filterPageUrl(token: string, sort: string, page: number): string {
        return `${HH_DOMAIN}/search?s=${token}&sort=${sort}&page=${page}`
    }

    /** Series cards are /m/S{id} anchors; the cover follows the id. */
    private parseTiles(html: string, seen: Set<string>): PartialSourceManga[] {
        const $ = cheerio.load(html)
        const tiles: PartialSourceManga[] = []

        for (const element of $('a[href*="/m/S"]').toArray()) {
            const anchor = $(element)

            const id = /\/m\/(S\d+)\/?$/.exec(anchor.attr('href') ?? '')?.[1]
            const title = anchor.text().trim()
            if (id == undefined || title.length === 0 || seen.has(id)) continue
            if (BANNED_LABELS.test(title)) continue

            seen.add(id)
            tiles.push(App.createPartialSourceManga({
                mangaId: id,
                image: `${HH_CDN}/cover/_${id}.jpg`,
                title: title
            }))
        }

        return tiles
    }

    private hasNextPage(html: string, page: number): boolean {
        const numbers = [...html.matchAll(/[?&]page=(\d+)/g)].map((match) => Number(match[1]))
        return numbers.some((value) => value > page)
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const html = await this.fetchHtml(this.getMangaShareUrl(mangaId))
        const $ = cheerio.load(html)

        const title = ($('meta[property="og:title"]').attr('content') ?? $('title').text())
            .replace(/\s*\|.*$/, '')
            .replace(/\s*(- Read Online.*|at HentaiHere.*)$/i, '')
            .trim() || mangaId

        const description = ($('meta[property="og:description"]').attr('content') ?? '').trim()
        const image = ($('meta[property="og:image"]').attr('content') ?? `${HH_CDN}/cover/_${mangaId}.jpg`).trim()

        // Every taxonomy entry on the page links to /search/T{id}; the labels
        // double as the gate.
        const tags: Tag[] = []
        const seen = new Set<string>()
        let banned = false
        for (const element of $('a[href*="/search/T"]').toArray()) {
            const anchor = $(element)
            const tagId = /\/search\/(T\d+)/.exec(anchor.attr('href') ?? '')?.[1]
            const label = anchor.text().trim()
            if (tagId == undefined || label.length === 0 || seen.has(tagId)) continue

            if (tagId === `T${BANNED_TAG_ID}` || BANNED_LABELS.test(label)) banned = true

            seen.add(tagId)
            tags.push(App.createTag({ id: tagId, label: label }))
        }

        // The gate: excluded content refuses to open even from an old
        // bookmark, since listing cards on this site carry no tag data.
        if (banned || BANNED_LABELS.test(title)) {
            throw new Error('This title carries content excluded by your settings (BL/yaoi) and will not be shown.')
        }

        const status = /status[^a-z]{0,10}completed/i.test(html) ? 'Completed' : 'Ongoing'

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [title],
                image: image,
                desc: description,
                status: status,
                tags: tags.length > 0
                    ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })]
                    : []
            })
        })
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const html = await this.fetchHtml(this.getMangaShareUrl(mangaId))

        if (BANNED_LABELS.test(cheerio.load(html)('a[href*="/search/T"]').text())) {
            throw new Error('This title carries content excluded by your settings (BL/yaoi) and will not be shown.')
        }

        const rows: { slug: string; number: number; name: string }[] = []
        const seen = new Set<string>()

        const $ = cheerio.load(html)
        for (const element of $(`a[href*="/m/${mangaId}/"]`).toArray()) {
            const anchor = $(element)

            const slug = new RegExp(`/m/${mangaId}/(\\d+(?:\\.\\d+)?)/`).exec(anchor.attr('href') ?? '')?.[1]
            if (slug == undefined || seen.has(slug)) continue

            const name = anchor.text().replace(/\s+/g, ' ').trim()

            seen.add(slug)
            rows.push({
                slug: slug,
                number: Number(slug),
                name: name.length > 0 ? name : `Chapter ${slug}`
            })
        }

        // The site has no upload dates on series pages, so chapters carry no
        // time rather than a fabricated one.
        rows.sort((a, b) => a.number - b.number)

        return rows.map((row, index) => App.createChapter({
            id: row.slug,
            chapNum: isNaN(row.number) ? index + 1 : row.number,
            name: row.name,
            langCode: '🇬🇧',
            sortingIndex: index
        }))
    }

    /**
     * The reader embeds its page list as `var rff_imageList = [...]` of CDN
     * paths; the prefix is the shared hentaicdn root.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const html = await this.fetchHtml(`${HH_DOMAIN}/m/${mangaId}/${chapterId}/1/`)

        const body = /rff_imageList\s*=\s*\[([^\]]*)\]/.exec(html)?.[1] ?? ''
        const pages: string[] = []
        for (const match of body.matchAll(/["']([^"']+)["']/g)) {
            const path = (match[1] as string).replace(/\\\//g, '/')
            if (path.length > 0) pages.push(`${HH_CDN}${path.startsWith('/') ? '' : '/'}${path}`)
        }

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

        // A typed title goes through the search engine with the exclusion
        // appended -- the minus operator matches category names, verified
        // live. A tag selection goes through the saved filter instead, where
        // the inclusion and the exclusion combine server-side.
        if (title.length > 0) {
            const html = await this.fetchHtml(`${HH_DOMAIN}/search?s=${encodeURIComponent(title + SEARCH_SUFFIX)}&page=${page}`)
            const tiles = this.parseTiles(html, seen)

            return App.createPagedResults({
                results: tiles,
                metadata: this.hasNextPage(html, page) ? { page: page + 1, seen: Array.from(seen) } : undefined
            })
        }

        // Tag ids come through as T-prefixed; the filter form wants the bare
        // number. "Always Excluded" markers are display-only and dropped.
        const numeric = (tags: { id: string }[] | undefined): string[] =>
            (tags ?? [])
                .map((tag) => tag.id)
                .filter((id) => /^T?\d+$/.test(id))
                .map((id) => id.replace(/^T/, ''))

        const tagIn = numeric(query.includedTags)
        const tagOut = numeric(query.excludedTags)

        if (metadata?.token != undefined) {
            const html = await this.fetchHtml(this.filterPageUrl(metadata.token, metadata.sort ?? 'newest', page))
            const tiles = this.parseTiles(html, seen)

            return App.createPagedResults({
                results: tiles,
                metadata: this.hasNextPage(html, page)
                    ? { page: page + 1, token: metadata.token, sort: metadata.sort, seen: Array.from(seen) }
                    : undefined
            })
        }

        const opened = await this.openFilter(tagIn, tagOut)
        const tiles = this.parseTiles(opened.html, seen)

        return App.createPagedResults({
            results: tiles,
            metadata: opened.token != undefined && this.hasNextPage(opened.html, 1)
                ? { page: 2, token: opened.token, sort: 'newest', seen: Array.from(seen) }
                : undefined
        })
    }

    /**
     * Exclusion is offered: the site's own filter takes a list of tags to
     * leave out (`s[tagOut]`), and the reader's choices are added to the
     * standing exclusion rather than replacing it.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    /**
     * Categories and content tags read live off the site's own tag indexes,
     * with anything matching the standing exclusions scrubbed from the offer.
     */
    async getSearchTags(): Promise<TagSection[]> {
        const sections: TagSection[] = []

        for (const [path, label] of [['category', 'Categories'], ['content', 'Content']] as [string, string][]) {
            try {
                const $ = cheerio.load(await this.fetchHtml(`${HH_DOMAIN}/tags/${path}`))
                const tags: Tag[] = []
                const seen = new Set<string>()

                for (const element of $('a[href*="/search/T"]').toArray()) {
                    const anchor = $(element)
                    const tagId = /\/search\/(T\d+)/.exec(anchor.attr('href') ?? '')?.[1]
                    const name = anchor.text().trim()
                    if (tagId == undefined || name.length === 0 || seen.has(tagId)) continue
                    if (tagId === `T${BANNED_TAG_ID}` || BANNED_LABELS.test(name)) continue

                    seen.add(tagId)
                    tags.push(App.createTag({ id: tagId, label: name }))
                }

                if (tags.length > 0) {
                    tags.sort((a, b) => a.label.localeCompare(b.label))
                    sections.push(App.createTagSection({ id: path, label: label, tags: tags }))
                }
            } catch {
                // A failed index leaves the other sections in place.
            }
        }

        return sections
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // One filter registration serves all three sections; each then pulls
        // its own sort of the same saved filter. Reported once each, only
        // after items are attached -- an unset `items` crashes the app.
        const opened = await this.openFilter()

        for (const entry of SECTIONS) {
            const section = App.createHomeSection({
                id: entry.id,
                title: entry.label,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: true,
                items: []
            })

            const html = opened.token != undefined
                ? await this.fetchHtml(this.filterPageUrl(opened.token, entry.sort, 1))
                : opened.html
            section.items = this.parseTiles(html, new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])
        const sort = SECTIONS.find((entry) => entry.id === homepageSectionId)?.sort ?? 'newest'

        let token = metadata?.token
        let html: string
        if (token == undefined) {
            const opened = await this.openFilter()
            token = opened.token
            html = token != undefined && sort !== 'newest'
                ? await this.fetchHtml(this.filterPageUrl(token, sort, page))
                : opened.html
        } else {
            html = await this.fetchHtml(this.filterPageUrl(token, sort, page))
        }

        const tiles = this.parseTiles(html, seen)

        return App.createPagedResults({
            results: tiles,
            metadata: token != undefined && this.hasNextPage(html, page)
                ? { page: page + 1, token: token, sort: sort, seen: Array.from(seen) }
                : undefined
        })
    }
}
