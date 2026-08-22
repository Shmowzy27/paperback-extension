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

export const H2R_DOMAIN = 'https://hentai2read.com'
const H2R_CDN = 'https://hentaicdn.com/hentai'

/**
 * Excluded by standing request. Yaoi is the site's own category ("Boy Love
 * (Yaoi)"); the taxonomy carries no fat, ugly bastard or bald categories, so
 * label matching covers any that appear later. Unlike the sibling sites this
 * one offers no server-side exclusion at all -- no filter parameter, no
 * preference cookie, and listing cards carry no category data -- so the
 * enforcement is the details gate plus scrubbing of everything the source
 * itself offers (see the class comment).
 */
const BANNED_LABELS = /yaoi|boys?.?love|shounen[ -]?ai|males only|tomgirl|crossdress|ugly bastard|\bbald\b|\bfat\b|gigantic breasts|\bold|\bdilf\b|\bgroup\b|\bbbm\b|\bmm+f\b|\bmonster|\btentacle|\balien\b/i
const BANNED_CATEGORY_SLUGS = new Set(['Yaoi'])

/**
 * Listing cards annotate themselves with numeric tag ids
 * (`data-tags="34-33-7-...-27-..."`), which lets listings be filtered before
 * anything is shown rather than leaning on the details gate alone.
 *
 * 27 is Yaoi, established from the site's own data: every card on the Yaoi
 * category listing carries it, against one card in forty-one on the latest
 * feed. It matches hentaihere's T27 -- the two are sister sites sharing a tag
 * table. (34 sits on every card everywhere, so it is a site-wide marker and no
 * signal at all.)
 */
const BANNED_TAG_IDS = new Set(['27'])

/** Path segments that look like series slugs but are site pages. */
const NOT_SERIES = new Set([
    'latest', 'trending', 'ranking', 'random', 'login', 'register', 'account',
    'hentai-list', 'tags', 'chapter', 'dmca', 'contact', 'about', 'terms',
    'privacy', 'faq', 'feed', 'sitemap', 'wp-content', 'wp-json', 'search'
])

const SECTIONS: { id: string; label: string; path: (page: number) => string }[] = [
    { id: 'latest', label: 'Latest Added', path: (page) => `/latest/${page}/` },
    { id: 'popular', label: 'Most Popular', path: (page) => `/hentai-list/all/any/all/most-popular/${page}/` },
    { id: 'trending', label: 'Trending', path: (page) => `/hentai-list/all/any/all/trending/${page}/` }
]

interface ListingMetadata {
    page?: number
    seen?: string[]
}

/**
 * hentai2read.com with the standing exclusions enforced as deeply as this
 * site allows.
 *
 * The site has no exclusion parameter anywhere, and its listing cards carry
 * no category information, so a banned title cannot always be kept off a raw
 * listing page. What is enforced: the offered tag catalog never includes the
 * banned categories, card titles matching the banned labels are dropped, and
 * -- decisively -- the details gate refuses to open any series whose own
 * category list carries a banned entry, so nothing excluded can actually be
 * read or land in the library.
 */
export const Hentai2ReadInfo: SourceInfo = {
    version: '1.4.0',
    name: 'Hentai2Read (Filtered)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from hentai2read.com with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: H2R_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class Hentai2Read implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${H2R_DOMAIN}/`,
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
        return `${H2R_DOMAIN}/${mangaId}/`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${H2R_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${H2R_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${Hentai2ReadInfo.name}> and press the cloud icon.`)
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
     * Series cards are anchors straight to /{slug}/. Sidebar widgets repeat
     * on every page, but the seen-set carried through the listing drops them
     * after their first appearance.
     */
    private parseTiles(html: string, seen: Set<string>, filters?: { include: string[]; exclude: string[] }): PartialSourceManga[] {
        const $ = cheerio.load(html)
        const tiles: PartialSourceManga[] = []

        // Listings render as book-grid cards carrying data-tags, so the
        // exclusion applies before anything reaches the reader. Search results
        // use a different, tagless card, which is why the details gate still
        // has to backstop everything.
        const grid = $('div.book-grid-item-container[data-tags]').toArray()
        for (const element of grid) {
            const card = $(element)

            const ids = (card.attr('data-tags') ?? '').split('-')
            if (ids.some((id) => BANNED_TAG_IDS.has(id))) continue

            // Whatever the reader chose, applied on the card's own ids.
            if (filters != undefined) {
                if (filters.exclude.some((id) => ids.includes(id))) continue
                if (!filters.include.every((id) => ids.includes(id))) continue
            }

            const anchor = card.find('a[href^="https://hentai2read.com/"]').first()
            const slug = /^https:\/\/hentai2read\.com\/([a-z0-9_]+)\/$/.exec(anchor.attr('href') ?? '')?.[1]
            if (slug == undefined || NOT_SERIES.has(slug) || seen.has(slug)) continue

            const title = anchor.text().replace(/\s+/g, ' ').replace(/\[[^\]]*\]\s*$/, '').trim()
            if (title.length === 0 || BANNED_LABELS.test(anchor.text())) continue

            const image = (card.find('img').first().attr('src') ?? '').trim()

            seen.add(slug)
            tiles.push(App.createPartialSourceManga({
                mangaId: slug,
                image: image.startsWith('http') ? image : `https:${image}`,
                title: title
            }))
        }

        if (grid.length > 0) return tiles

        for (const element of $('a[href^="https://hentai2read.com/"]').toArray()) {
            const anchor = $(element)

            const slug = /^https:\/\/hentai2read\.com\/([a-z0-9_]+)\/$/.exec(anchor.attr('href') ?? '')?.[1]
            if (slug == undefined || NOT_SERIES.has(slug) || seen.has(slug)) continue

            // Only anchors that actually present the series -- an image or a
            // data-title -- count as cards; bare text links are navigation.
            const image = anchor.find('img').first().attr('src') ?? ''
            const title = (anchor.attr('data-title') ?? anchor.text()).replace(/\s+/g, ' ').replace(/\[[^\]]*\]\s*$/, '').trim()
            if (image.length === 0 || title.length === 0) continue
            if (BANNED_LABELS.test(anchor.text()) || BANNED_LABELS.test(title)) continue

            seen.add(slug)
            tiles.push(App.createPartialSourceManga({
                mangaId: slug,
                image: image.startsWith('http') ? image : `https:${image}`,
                title: title
            }))
        }

        return tiles
    }

    /**
     * A category's numeric id, resolved from the site's own listing for it:
     * the id carried by every card on that category's page is the category
     * itself. The catalogs are offered as names while cards annotate
     * themselves with numbers, and the site's search takes no filters, so this
     * is what lets a reader's choice be applied at all.
     *
     * Resolved once and remembered, unresolvable ones included, so a bad name
     * is not retried on every page.
     */
    private categoryIds = new Map<string, string | undefined>()

    private async categoryId(tagId: string): Promise<string | undefined> {
        if (this.categoryIds.has(tagId)) return this.categoryIds.get(tagId)

        const name = tagId.startsWith('cat:') ? tagId.slice(4) : tagId
        let resolved: string | undefined

        try {
            const html = await this.fetchHtml(`${H2R_DOMAIN}/hentai-list/category/${encodeURIComponent(name)}/1/`)

            const perCard = [...html.matchAll(/data-tags="([^"]*)"/g)]
                .map((match) => (match[1] as string).split('-').filter((id) => id.length > 0))
            if (perCard.length > 0) {
                const common = perCard.reduce((carried, ids) => carried.filter((id) => ids.includes(id)), perCard[0] as string[])
                // 34 sits on every card site-wide, so it is never the answer.
                const candidates = common.filter((id) => id !== '34')
                if (candidates.length === 1) resolved = candidates[0]
            }
        } catch {
            // Left unresolved; the filter is simply not applied.
        }

        this.categoryIds.set(tagId, resolved)
        return resolved
    }

    /**
     * The reader's chosen categories as card ids. The first included one is
     * handled by browsing its own listing, so only the rest need applying card
     * by card.
     */
    private async resolveFilters(query: SearchRequest, skipFirstInclude: boolean): Promise<{ include: string[]; exclude: string[] }> {
        const included = (query.includedTags ?? []).map((tag) => tag.id)
        const rest = skipFirstInclude ? included.slice(1) : included

        const include: string[] = []
        for (const id of rest) {
            const resolved = await this.categoryId(id)
            if (resolved != undefined) include.push(resolved)
        }

        const exclude: string[] = []
        for (const tag of query.excludedTags ?? []) {
            const resolved = await this.categoryId(tag.id)
            if (resolved != undefined) exclude.push(resolved)
        }

        return { include: include, exclude: exclude }
    }

    private hasNextPage(html: string, page: number): boolean {
        const numbers = [...html.matchAll(/\/(\d+)\/"/g)].map((match) => Number(match[1]))
        return numbers.some((value) => value === page + 1)
    }

    /**
     * Scoped to the series' own meta list (`ul.list-simple-mini a.tagButton`):
     * the site's nav menu carries a "Boy Love (Yaoi)" link on every page, and
     * a page-wide scan gated every single title because of it.
     */
    private bannedFrom($: cheerio.CheerioAPI): boolean {
        for (const element of $('ul.list-simple-mini a.tagButton[href*="/hentai-list/category/"]').toArray()) {
            const slug = decodeURIComponent(/\/hentai-list\/category\/([^/"]+)/.exec($(element).attr('href') ?? '')?.[1] ?? '')
            const label = $(element).text().trim()
            if (BANNED_CATEGORY_SLUGS.has(slug) || BANNED_LABELS.test(label)) return true
        }
        return false
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const html = await this.fetchHtml(this.getMangaShareUrl(mangaId))
        const $ = cheerio.load(html)

        // The gate: the series' own category list decides. This is the layer
        // that actually holds on this site, since listings cannot be trusted
        // to carry the information.
        if (this.bannedFrom($)) {
            throw new Error('This title carries content excluded by your settings (BL/yaoi) and will not be shown.')
        }

        const title = ($('meta[property="og:title"]').attr('content') ?? $('title').text())
            .replace(/\s*(?:- Page \d+.*|at Hentai2Read.*|\| Hentai2Read.*)$/i, '')
            .replace(/\s*\[[^\]]*\]\s*$/, '')
            .trim() || mangaId

        const image = ($('meta[property="og:image"]').attr('content') ?? $('img[src*="/cover/"]').first().attr('src') ?? '').trim()
        const description = ($('meta[property="og:description"]').attr('content') ?? '').trim()

        const author = $('ul.list-simple-mini a.tagButton[href*="/hentai-list/artist/"], ul.list-simple-mini a.tagButton[href*="/hentai-list/author/"]').toArray()
            .map((element) => $(element).text().trim())
            .filter((name, index, list) => name.length > 0 && list.indexOf(name) === index)
            .join(', ')

        const tags: Tag[] = []
        const seen = new Set<string>()
        for (const element of $('ul.list-simple-mini a.tagButton[href*="/hentai-list/category/"]').toArray()) {
            const slug = /\/hentai-list\/category\/([^/"]+)/.exec($(element).attr('href') ?? '')?.[1]
            const label = $(element).text().trim()
            if (slug == undefined || label.length === 0 || seen.has(slug)) continue

            seen.add(slug)
            tags.push(App.createTag({ id: slug, label: label }))
        }

        const status = /\/hentai-list\/status\/Completed\//.test($('ul.list-simple-mini').html() ?? '') ? 'Completed' : 'Ongoing'

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [title],
                image: image,
                desc: description,
                status: status,
                author: author,
                tags: tags.length > 0
                    ? [App.createTagSection({ id: 'category', label: 'Categories', tags: tags })]
                    : []
            })
        })
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const html = await this.fetchHtml(this.getMangaShareUrl(mangaId))
        const $ = cheerio.load(html)

        if (this.bannedFrom($)) {
            throw new Error('This title carries content excluded by your settings (BL/yaoi) and will not be shown.')
        }

        const rows: { slug: string; number: number; name: string }[] = []
        const seen = new Set<string>()

        for (const element of $(`a[href^="https://hentai2read.com/${mangaId}/"]`).toArray()) {
            const anchor = $(element)

            const slug = new RegExp(`^https://hentai2read\\.com/${mangaId}/(\\d+(?:\\.\\d+)?)/$`).exec(anchor.attr('href') ?? '')?.[1]
            if (slug == undefined || seen.has(slug)) continue

            const name = anchor.text().replace(/\s+/g, ' ').trim()

            seen.add(slug)
            rows.push({
                slug: slug,
                number: Number(slug),
                name: name.length > 0 ? name : `Chapter ${slug}`
            })
        }

        // The site shows no per-chapter upload dates, so chapters carry no
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
     * The reader embeds `var gData = { ..., 'images': [...] }` of CDN paths
     * under the shared hentaicdn root.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const html = await this.fetchHtml(`${H2R_DOMAIN}/${mangaId}/${chapterId}/`)

        const body = /['"]images['"]\s*:\s*\[([^\]]*)\]/.exec(html)?.[1] ?? ''
        const pages: string[] = []
        for (const match of body.matchAll(/["']([^"']+)["']/g)) {
            const path = (match[1] as string).replace(/\\\//g, '/')
            if (path.length > 0) pages.push(`${H2R_CDN}${path.startsWith('/') ? '' : '/'}${path}`)
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

        // The site's search is a POST that answers a single page of results;
        // it accepts no genre filters, so the results lean on the card-level
        // label drop here and on the details gate beyond it.
        if (title.length > 0) {
            const filters = await this.resolveFilters(query, false)
            const html = await this.fetchHtml(
                `${H2R_DOMAIN}/hentai-list/search/`,
                'POST',
                `cmd_wpm_wgt_mng_sch_sbm=Search&txt_wpm_wgt_mng_sch_nme=${encodeURIComponent(title)}`
            )

            return App.createPagedResults({
                results: this.parseTiles(html, seen, filters),
                metadata: undefined
            })
        }

        // The first chosen category browses its own listing, which the server
        // can do; further ones, and everything to leave out, are applied per
        // card, the site offering no filter parameters of its own.
        const browsing = selected != undefined && selected.startsWith('cat:')
        const path = browsing
            ? `/hentai-list/category/${encodeURIComponent(selected.slice(4))}/${page}/`
            : SECTIONS[0]!.path(page)

        const filters = await this.resolveFilters(query, browsing)
        const html = await this.fetchHtml(`${H2R_DOMAIN}${path}`)
        const tiles = this.parseTiles(html, seen, filters)

        return App.createPagedResults({
            results: tiles,
            metadata: this.hasNextPage(html, page) ? { page: page + 1, seen: Array.from(seen) } : undefined
        })
    }

    /**
     * Exclusion is offered. The site takes no filter parameters at all, so it
     * is done against each card's own tag ids. Whatever the reader leaves out
     * is on top of the standing exclusions, which cannot be undone.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    /**
     * The category catalog read live off the site's own A-Z index, with the
     * banned categories scrubbed from the offer.
     */
    async getSearchTags(): Promise<TagSection[]> {
        const $ = cheerio.load(await this.fetchHtml(`${H2R_DOMAIN}/hentai-list/advanced-search/`))

        const tags: Tag[] = []
        const seen = new Set<string>()

        for (const element of $('a[href*="/hentai-list/category/"]').toArray()) {
            const slug = /\/hentai-list\/category\/([^/"]+)/.exec($(element).attr('href') ?? '')?.[1]
            const label = $(element).text().trim()
            if (slug == undefined || label.length === 0 || seen.has(slug)) continue
            if (BANNED_CATEGORY_SLUGS.has(decodeURIComponent(slug)) || BANNED_LABELS.test(label)) continue

            seen.add(slug)
            tags.push(App.createTag({ id: `cat:${decodeURIComponent(slug)}`, label: label }))
        }

        tags.sort((a, b) => a.label.localeCompare(b.label))

        return tags.length > 0
            ? [App.createTagSection({ id: 'category', label: 'Categories', tags: tags })]
            : []
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

            const html = await this.fetchHtml(`${H2R_DOMAIN}${entry.path(1)}`)
            section.items = this.parseTiles(html, new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        const entry = SECTIONS.find((candidate) => candidate.id === homepageSectionId) ?? SECTIONS[0]!
        const html = await this.fetchHtml(`${H2R_DOMAIN}${entry.path(page)}`)
        const tiles = this.parseTiles(html, seen)

        return App.createPagedResults({
            results: tiles,
            metadata: this.hasNextPage(html, page) ? { page: page + 1, seen: Array.from(seen) } : undefined
        })
    }
}
