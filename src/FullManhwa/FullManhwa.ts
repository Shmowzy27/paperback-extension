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
    bannedGenreOn,
    isLastPage,
    parseChapters,
    parseGenres,
    parseMangaDetails,
    parsePages,
    parseTiles,
    routeFor,
    SM_BANNED_GENRE_SLUGS,
    SM_BASE,
    SM_GENRE_PREFIX,
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
    version: '2.5.1',
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
        // One a second, not three. The origin needs two to eight seconds to
        // answer a series page, so three a second left twenty-odd requests in
        // flight at once and the site began turning the whole device away with
        // its own "Service temporarily unavailable" page -- which reads as a
        // Cloudflare block in the app while the same pages load fine on a
        // desktop. Refreshing a whole library is what tips it over.
        requestsPerSecond: 1,
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

    /**
     * What a Cloudflare challenge page actually looks like. A 503 on its own is
     * not one: the site answers a device it has decided is asking for too much
     * with its own "Service temporarily unavailable" page, and calling that a
     * Cloudflare block sends the reader to press the cloud icon, which cannot
     * help -- the WebView it opens is turned away exactly the same way.
     */
    private looksLikeChallenge(body: string): boolean {
        return /just a moment|cf-browser-verification|__cf_chl|cf_chl_opt|attention required|checking your browser/i.test(body)
    }

    private checkResponse(status: number, body: string): void {
        if (status === 403 || (status === 503 && this.looksLikeChallenge(body))) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${FullManhwaInfo.name}> and press the cloud icon.`)
        }

        // The site turning the device away, rather than Cloudflare standing in
        // front of it. Waiting fixes this one; the cloud icon does nothing.
        if (status === 503 || status === 429) {
            throw new Error(`${FullManhwaInfo.name} is turning requests away right now (HTTP ${status}).\nThe site limits how much one device may ask for at once, and refreshing a whole library will do it. Wait a few minutes and try again.`)
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

    /**
     * Waits, where the runtime has a timer to wait on. `setTimeout` is not part
     * of the language and JavaScriptCore need not provide it, so its absence
     * costs the backoff rather than throwing.
     */
    private async pause(ms: number): Promise<void> {
        const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
        if (typeof timer !== 'function') return
        await new Promise<void>((resolve) => timer(() => resolve(), ms))
    }

    /**
     * Retries a request the site turned away, backing off between attempts.
     *
     * The site answers a burst with its own 503 "Service temporarily
     * unavailable" page and then keeps answering it for a minute or two --
     * measured, along with series pages that take three to fourteen seconds
     * and one that took seventy-eight. The response carries `retry-after: 1`,
     * which is not true: retrying after a second was still refused. So the
     * waits are seconds, not the one the site claims, and long enough that a
     * blip is ridden out inside the one request the reader is waiting on.
     */
    private static readonly BACKOFF_MS = [2000, 6000, 12000]

    private async fetch(url: string, headers?: Record<string, string>): Promise<Response> {
        let response: Response | undefined

        for (let attempt = 0; attempt <= FullManhwa.BACKOFF_MS.length; attempt++) {
            const request = App.createRequest({ url: url, method: 'GET', headers: headers })
            response = await this.requestManager.schedule(request, 3)

            const body = (response.data as string) ?? ''
            const turnedAway = response.status === 429
                || (response.status === 503 && !this.looksLikeChallenge(body))
            if (!turnedAway) break

            const wait = FullManhwa.BACKOFF_MS[attempt]
            if (wait == undefined) break
            await this.pause(wait)
        }

        const settled = response as Response
        this.checkResponse(settled.status, (settled.data as string) ?? '')
        return settled
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
    private async walkListing(urlFor: (page: number) => string, page: number, seen: Set<string>, exclude?: Set<string>, require?: Set<string>): Promise<{ tiles: PartialSourceManga[]; nextPage?: number }> {
        const tiles: PartialSourceManga[] = []
        let current = page

        for (let hop = 0; hop < 4; hop++) {
            const $ = await this.loadPage(urlFor(current))
            const rows = parseTiles($).filter((row) => {
                if (exclude != undefined && exclude.has(row.slug)) return false
                if (require != undefined && !require.has(row.slug)) return false
                return true
            })
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

    private async pagedListing(urlFor: (page: number) => string, page: number, seen: Set<string>, exclude?: Set<string>, require?: Set<string>): Promise<PagedResults> {
        const walk = await this.walkListing(urlFor, page, seen, exclude, require)

        return App.createPagedResults({
            results: walk.tiles,
            metadata: walk.nextPage == undefined ? undefined : { page: walk.nextPage, seen: Array.from(seen) }
        })
    }

    /**
     * Which series sit under a genre, gathered from the site's own genre
     * listing and kept for an hour.
     *
     * This is the only way genre can be applied to a listing here. A card
     * carries a cover and a title and nothing else -- no genre, no data
     * attributes -- the site publishes no JSON API, and its filter takes a
     * single genre and ignores every array, comma and minus form. So a genre
     * is turned into the set of series under it, and the sets do the work.
     */
    private genreMembers = new Map<string, { at: number; slugs: Set<string> }>()

    private static readonly MEMBERSHIP_TTL = 3600000

    /**
     * Four pages, ninety-six series. Every excluded genre on this site is far
     * smaller than that -- the largest, monsters, has seventeen, and most have
     * one -- so the cap only ever bites on a broad genre a reader chose to
     * leave out themselves, where it degrades to filtering the most recent
     * rather than to filtering nothing.
     */
    private static readonly MEMBERSHIP_PAGES = 4

    private async membersOf(slug: string): Promise<Set<string>> {
        const cached = this.genreMembers.get(slug)
        if (cached != undefined && Date.now() - cached.at < FullManhwa.MEMBERSHIP_TTL) return cached.slugs

        const slugs = new Set<string>()
        for (let page = 1; page <= FullManhwa.MEMBERSHIP_PAGES; page++) {
            const rows = parseTiles(await this.loadPage(this.listingUrl(`${SM_GENRE_PREFIX}${slug}`, page)))

            let fresh = 0
            for (const row of rows) {
                if (slugs.has(row.slug)) continue
                slugs.add(row.slug)
                fresh++
            }

            // The site serves the same page again rather than an empty one
            // past the end, so a page that adds nothing is the end.
            if (fresh === 0) break
        }

        this.genreMembers.set(slug, { at: Date.now(), slugs: slugs })
        return slugs
    }

    /**
     * Every series under a standing-excluded genre.
     *
     * Warmed one genre per listing rather than all at once: eight genres is
     * eight requests against an origin that needs seconds for each, and
     * holding up the first listing by half a minute to do it would trade one
     * complaint for another. Until it is warm the details gate below is what
     * enforces the rule, and it needs no requests of its own.
     */
    private async bannedSeries(warm: boolean): Promise<Set<string>> {
        const all = new Set<string>()
        let warmedOne = false

        for (const slug of SM_BANNED_GENRE_SLUGS) {
            const cached = this.genreMembers.get(slug)
            if (cached != undefined && Date.now() - cached.at < FullManhwa.MEMBERSHIP_TTL) {
                cached.slugs.forEach((member) => all.add(member))
                continue
            }

            if (!warm || warmedOne) continue
            warmedOne = true

            try {
                (await this.membersOf(slug)).forEach((member) => all.add(member))
            } catch {
                // A genre that would not load is simply not subtracted this
                // time; the details gate still refuses anything under it.
            }
        }

        return all
    }

    /**
     * The series a reader's own excluded genres cover. Kept separate from the
     * standing exclusions because it is a preference rather than a rule: it is
     * applied to listings, where a title can be left out quietly, and not at
     * the details gate, where it would surface as an error on a title the app
     * had just offered.
     */
    private async excludedSeries(query: SearchRequest): Promise<Set<string>> {
        const all = new Set<string>()

        for (const tag of query.excludedTags ?? []) {
            const id = tag.id ?? ''
            if (!id.startsWith(SM_GENRE_PREFIX)) continue

            try {
                (await this.membersOf(id.slice(SM_GENRE_PREFIX.length))).forEach((member) => all.add(member))
            } catch {
                // Leaves that one genre unfiltered rather than failing the search.
            }
        }

        return all
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const $ = await this.loadPage(this.getMangaShareUrl(mangaId))

        // Decisive, and free: the page is already loaded, and its own genre
        // links are the only place this site states a series' genres.
        const banned = bannedGenreOn($)
        if (banned != undefined) {
            throw new Error(`This title is filed under "${banned}", which your settings exclude, and will not be shown.`)
        }

        return parseMangaDetails($, mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const $ = await this.loadPage(this.getMangaShareUrl(mangaId))

        const banned = bannedGenreOn($)
        if (banned != undefined) {
            throw new Error(`This title is filed under "${banned}", which your settings exclude, and will not be shown.`)
        }

        return parseChapters($)
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
        const included = (query.includedTags ?? []).map((tag) => tag.id ?? '').filter((id) => id.length > 0)
        const selected = included[0]

        // A title goes through the catalog's own `q`; a bare tag selection
        // browses that listing instead.
        const urlFor = title.length > 0
            ? (p: number) => `${SM_BASE}/series?q=${encodeURIComponent(title)}&page=${p}`
            : (p: number) => this.listingUrl(selected ?? 'latest', p)

        // The site takes one genre and one only -- repeating the parameter
        // keeps the last, and the array, comma and minus forms all return an
        // empty page. So the first choice is browsed on the server and any
        // further ones are applied here, as the series they cover.
        let require: Set<string> | undefined
        for (const id of included.slice(1)) {
            if (!id.startsWith(SM_GENRE_PREFIX)) continue

            const members = await this.membersOf(id.slice(SM_GENRE_PREFIX.length))
            require = require == undefined
                ? members
                : new Set(Array.from(require).filter((slug) => members.has(slug)))
        }

        const exclude = await this.excludedSeries(query)
        for (const slug of await this.bannedSeries(true)) exclude.add(slug)

        return this.pagedListing(urlFor, page, seen, exclude, require)
    }

    /**
     * Exclusion is offered. The site cannot do it -- there is no exclusion
     * parameter, and a listing card carries no genre to test -- so a genre to
     * leave out is turned into the series under it and those are dropped from
     * the listing. Whatever the reader excludes is on top of the standing
     * exclusions, which cannot be switched back on.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return true
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

            // Warmed by the first section only. Three sections warming a genre
            // apiece would put three extra requests in front of the home
            // screen; one keeps the standing set filling in without the wait
            // being noticed.
            const banned = await this.bannedSeries(entry === SM_SECTIONS[0])
            const walk = await this.walkListing((p) => this.listingUrl(entry.id, p), 1, new Set<string>(), banned)
            section.items = walk.tiles
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        return this.pagedListing((p) => this.listingUrl(homepageSectionId, p), page, seen, await this.bannedSeries(true))
    }
}
