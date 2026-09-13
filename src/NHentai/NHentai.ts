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

import { bannedTagName } from './ContentRules'
import { PARODY_IDS, RULE_TAG_IDS } from './RuleIds'

export const NH_DOMAIN = 'https://nhentai.net'
const NH_API = `${NH_DOMAIN}/api/v2`

/** The image CDN reported by /api/v2/cdn; any of i1-i4 serves every gallery. */
const NH_IMAGE_CDN = 'https://i1.nhentai.net'
const NH_THUMB_CDN = 'https://t1.nhentai.net'

/**
 * Excluded by standing request: no BL/yaoi/male-to-male content, and no ugly
 * bastard or bald content. The ids are nhentai's own, resolved live from
 * /api/v2/tags/tag/{slug} and re-verified against a yaoi gallery; there is no
 * "fat" tag on this site. The names feed the search negation and the ids the
 * client-side backstop, since listing entries carry only tag_ids.
 */
export const NH_BANNED: { id: number; name: string }[] = [
    // BL and male-to-male
    { id: 23895, name: 'yaoi' },
    { id: 21712, name: 'males only' },
    { id: 29023, name: 'tomgirl' },
    { id: 15782, name: 'crossdressing' },
    // appearance
    { id: 162979, name: 'ugly bastard' },
    { id: 73750, name: 'bald' },
    { id: 80498, name: 'gigantic breasts' },
    // age
    { id: 2956, name: 'old man' },
    { id: 133145, name: 'grandfather' },
    { id: 29013, name: 'dilf' },
    // group and arrangement
    { id: 31880, name: 'bbm' },
    { id: 7256, name: 'mmf threesome' },
    // creatures
    { id: 18567, name: 'monster' },
    { id: 7550, name: 'monster girl' },
    { id: 31775, name: 'tentacles' },
    { id: 17967, name: 'alien' }
]

/**
 * Names negated in every search but with no id to check a listing entry
 * against, because the site has no such tag to resolve one from. Harmless to
 * ask for: the API simply matches nothing.
 */
const NH_BANNED_NAMES_ONLY = [
    'mmmf', 'older man younger woman', 'old guy',
    // multiple male-bodied participants
    'mmm threesome', 'mmt threesome', 'mtf threesome', 'ttf threesome',
    'ttm threesome', 'gang rape', 'gangbang', 'orgy', 'reverse harem',
    // animals and creatures
    'bestiality', 'low bestiality', 'furry', 'animal on animal',
    'human on furry', 'octopus', 'slime', 'insect', 'snake', 'spider',
    'worm', 'centaur', 'minotaur', 'horse', 'horse cock', 'dog', 'cat',
    'pig', 'fish', 'frog', 'bear', 'wolf'
]

/**
 * Anime and game parodies are excluded, leaving original works. Anything the
 * site files under a parody other than its own "original" is refused.
 */
const ORIGINAL_PARODY_ID = 90671

/** Pages of the parody catalog warmed while browsing. See parodyIds. */
const PARODY_CATALOG_PAGES = 12

/**
 * Every tag id the rules exclude. The named sixteen above, and -- since a
 * listing entry carries only ids -- every other tag in the site's catalog whose
 * name the rules exclude (bannedTagName in ContentRules.ts), read off the whole
 * catalog into RuleIds.ts. Before, a tag named only in the search negation
 * ("gangbang", "furry") or in no list at all ("fox girl", "orc") had no id
 * here, so nothing checked it once a listing came back.
 */
const BANNED_IDS = new Set([...NH_BANNED.map((tag) => tag.id), ...RULE_TAG_IDS])

/**
 * Every parody's id bar "original", carried in the bundle. The catalog used to
 * be warmed a page per listing on the device; at ten requests a minute the
 * first screen knew the top hundred parodies at best -- a Detective Conan
 * parody sat in the listing -- and none at all when that request was refused.
 */
const PARODY_ID_SET = new Set(PARODY_IDS)

/**
 * Appended to every search the source makes. The API's own negation syntax, so
 * the server never returns the excluded content in the first place.
 */
const EXCLUSION = NH_BANNED.map((tag) => ` -tag:"${tag.name}"`).join('')
    + NH_BANNED_NAMES_ONLY.map((name) => ` -tag:"${name}"`).join('')

/**
 * English only, by request. Every search the source makes carries
 * `language:english` (see searchUrl), and every gallery must carry the english
 * language tag, id 12227, before it is shown or opened. It used to be added
 * only when a query had nothing else positive in it, so a netorare tag search
 * came back with sixteen Chinese galleries and two Japanese in twenty-five.
 *
 * The list stays so a bare `english` filter id still resolves to its type.
 */
const LANGUAGES: { id: string; label: string }[] = [
    { id: 'english', label: 'English' }
]

const ENGLISH_ID = 12227

/**
 * The site's own "multi-work series" tag, on some 57,000 galleries: its word
 * that a gallery has siblings. It is what lets an unnumbered first volume, or
 * a number mid-title, be treated as part of a series without guessing.
 */
const MULTI_WORK_SERIES_ID = 21572

const isMultiWork = (tagIds: number[] | undefined): boolean => (tagIds ?? []).includes(MULTI_WORK_SERIES_ID)

/**
 * The group rule (ContentRules.ts) in this site's tag ids: "group" is allowed
 * with one man among several women -- sole male, ffm threesome, harem -- and
 * refused with sole female, or with nothing to say there is one man. Mesu no
 * Ie III carries group, sole male and ffm threesome, and is shown.
 */
const GROUP_RULE = { group: [8010], oneMale: [35763, 15348, 15785], oneFemale: [35762] }

/**
 * Browsable tag catalogs, the way HentaiNexus offers its categories. Each type
 * costs one request, and the API caps a page at a hundred entries, so the most
 * popular of each are offered rather than all 4,696 tags -- pulling the lot
 * would be forty requests against an allowance of about ten a minute.
 *
 * A selected tag becomes the API's own `type:"name"` term, which is the same
 * id a tag carries on a details page, so tapping one there browses it too.
 */
const TAG_TYPES: { type: string; label: string }[] = [
    { type: 'tag', label: 'Tags' },
    { type: 'artist', label: 'Artists' }
    // No parodies: every parody is excluded, and a filter that cannot return
    // anything is worse than none.
]

const SECTIONS: { id: string; label: string; sort: string }[] = [
    { id: 'new', label: 'New Uploads (English)', sort: 'date' },
    { id: 'popular-week', label: 'Popular This Week (English)', sort: 'popular-week' },
    { id: 'popular', label: 'All-Time Popular (English)', sort: 'popular' }
]

/**
 * Galleries on nhentai are flat: a multi-volume work is published as several
 * separate galleries, exactly the shape HentaiNexus faces. So volumes are
 * merged into one library entry -- the rules that read a series off a title
 * live in SeriesMerge.ts beside this file, shared with AsmHentai and HentaiNexus so
 * a fix lands in all three at once.
 *
 * The sister sites need none of this: hentaihere and hentai2read already model
 * a series with several chapters natively.
 *
 * Re-exported so the offline checks can reach them through the bundle.
 */
import {
    cleanTitle,
    FoldItem,
    FoldMemo,
    foldedInto,
    foldTiles,
    isLongName,
    nothingToShow,
    orderVolumes,
    seriesKey,
    splitTitle,
    volumeOf
} from './SeriesMerge'
export { cleanTitle, creatorOf, creatorsOf, seriesKey, sharesSubtitle, sharesLead, sharesTail, splitTitle } from './SeriesMerge'
import { GROUP_REFUSAL_MESSAGE, groupRefusedByIds } from './ContentRules'
export { bannedTagName, groupRefusal, groupRefusedByIds, STANDING_LABELS, TAG_ONLY_LABELS } from './ContentRules'

const SERIES_PREFIX = 's:'
export const seriesIdFor = (title: string): string => `${SERIES_PREFIX}${splitTitle(title).base}`
export const isSeriesId = (mangaId: string): boolean => mangaId.startsWith(SERIES_PREFIX)
export const baseFromSeriesId = (mangaId: string): string => mangaId.slice(SERIES_PREFIX.length)

/**
 * Turns a chosen filter into one of the API's own search terms, with a leading
 * minus when it is to be left out.
 *
 * Tag ids carry their type (`artist:foo`), which is also the id a tag has on a
 * details page, so tapping one there filters by it. A bare language id has no
 * type and becomes `language:english`.
 */
export const searchTermFor = (tagId: string, exclude: boolean): string => {
    const separator = tagId.indexOf(':')
    const known = LANGUAGES.some((entry) => entry.id === tagId)

    const prefix = separator < 0 ? (known ? 'language' : 'tag') : tagId.slice(0, separator)
    const value = separator < 0 ? tagId : tagId.slice(separator + 1)

    const quoted = /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value
    return `${exclude ? '-' : ''}${prefix}:${quoted}`
}

/**
 * The phrase used to find a series' other volumes. Quotes are stripped and a
 * leading minus neutralised: both are search operators here, and letting them
 * through turns the lookup into a different query -- the same failure that once
 * left HentaiNexus reporting "No volumes found" for any title holding one.
 */
export const seriesQuery = (base: string): string => {
    const phrase = base.replace(/["]/g, ' ').replace(/(^|\s)-+/g, '$1').replace(/\s+/g, ' ').trim()
    return phrase.length > 0 ? `"${phrase}"` : base
}

interface ApiListing {
    id: number
    english_title?: string
    japanese_title?: string
    thumbnail?: string
    tag_ids?: number[]
    // Present on search results, which is what lets a listing entry stand in
    // for the gallery record on the details screen.
    media_id?: string
    num_pages?: number
}

interface ApiTag {
    id: number
    type: string
    name: string
}

interface ApiGallery {
    id: number
    media_id: string
    title?: { english?: string; pretty?: string }
    cover?: { path?: string }
    thumbnail?: string
    upload_date?: number
    tags?: ApiTag[]
    num_pages?: number
    pages?: { path?: string }[]
}

interface ListingMetadata {
    page?: number
    seen?: string[]
}

/**
 * nhentai through its own v2 JSON API.
 *
 * Volumes published as separate galleries are merged into one library entry
 * the way HentaiNexus does it, since this site models no series of its own.
 * Each volume becomes a chapter of that entry.
 *
 * Excluded by construction: the standing BL/yaoi rule plus ugly bastard and
 * bald, negated inside every search query so the server filters, and every
 * returned entry re-checked against the banned tag ids as the backstop.
 */
export const NHentaiInfo: SourceInfo = {
    version: '2.4.3',
    name: 'nhentai (Filtered)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls galleries from nhentai.net with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: NH_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class NHentai implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    /**
     * The name the source calls itself in messages. A property rather than
     * NHentaiInfo.name read directly, so a source built on this one -- "nhentai
     * (new)" -- names itself, not this one.
     */
    protected readonly displayName: string = NHentaiInfo.name

    requestManager = App.createRequestManager({
        // The documented anonymous ceiling is fifteen requests a minute, but
        // measuring it says otherwise: at exactly that rate the API starts
        // answering 429 (retry-after: 60) from the eleventh request onward, so
        // the real allowance is nearer ten a rolling minute. Pacing sat on the
        // documented figure and tripped the true one, which took out whole
        // Discover pages, since one 429 fails the section outright.
        //
        // Seven seconds is a little over eight a minute, leaving headroom. The
        // rate alone was never going to be enough, though -- what makes this
        // workable is that an unnumbered gallery now opens on one request.
        requestsPerSecond: 0.14,
        requestTimeout: 60000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${NH_DOMAIN}/`,
                        'accept': 'application/json',
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

    /**
     * A merged series has no page of its own on the site, so sharing one
     * points at the search for its name; a plain gallery id links directly.
     */
    getMangaShareUrl(mangaId: string): string {
        return isSeriesId(mangaId)
            ? `${NH_DOMAIN}/search/?q=${encodeURIComponent(seriesQuery(baseFromSeriesId(mangaId)))}`
            : `${NH_DOMAIN}/g/${mangaId}/`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${NH_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${NH_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${this.displayName}> and press the cloud icon.`)
        }
        if (status === 429) {
            throw new Error('nhentai is rate limiting this connection (HTTP 429). It allows about ten requests a minute and clears after sixty seconds -- wait a minute, then pull to refresh.')
        }
        if (status >= 500) {
            throw new Error(`The site returned an error (HTTP ${status}). It is probably down or overloaded -- try again shortly.`)
        }
        if (status < 200 || status >= 300) {
            throw new Error(`Unexpected response from the site (HTTP ${status}).`)
        }
    }

    /**
     * Short-lived memo of things just fetched, so that opening an entry costs
     * one round of requests rather than two.
     *
     * Paperback calls getMangaDetails and getChapters back to back, and both
     * need the same sibling search and the same gallery record; without this
     * each open paid for them twice. Entries are dropped after a couple of
     * minutes so a refresh still sees new volumes.
     */
    private memo = new Map<string, { at: number; value: unknown; ttl: number }>()

    private remembered<T>(key: string): T | undefined {
        const entry = this.memo.get(key)
        if (entry == undefined) return undefined

        if (Date.now() - entry.at > entry.ttl) {
            this.memo.delete(key)
            return undefined
        }
        return entry.value as T
    }

    private remember(key: string, value: unknown, ttl: number = 120000): void {
        // Bounded so a long browse cannot grow it without limit, but no longer
        // at 400. A listing page now leaves eighty-odd entries here -- the
        // listing entries that make opening instant, and the records of what
        // each tile folded in -- so at 400 a five-page scroll began evicting
        // the first tiles' records, and those tiles opened without the volumes
        // they had absorbed: the merge hiding a volume again. Three thousand
        // small entries is well under a megabyte and holds a long browse; the
        // oldest third goes when it fills.
        if (this.memo.size > 3000) {
            const oldest = [...this.memo.entries()]
                .sort((a, b) => a[1].at - b[1].at)
                .slice(0, 1000)
            for (const [key] of oldest) this.memo.delete(key)
        }
        this.memo.set(key, { at: Date.now(), value: value, ttl: ttl })
    }

    /**
     * Tag names by id, built from the catalogs the filter screen already
     * fetches. Listing entries carry only tag ids, so this is what lets an
     * entry's details be rendered without asking the API for the gallery.
     * Fetched once and kept for an hour; if it cannot be had, details simply
     * show fewer tags rather than costing a request.
     */
    private async tagNames(): Promise<Map<number, { type: string; name: string }>> {
        const cached = this.remembered<Map<number, { type: string; name: string }>>('tagmap')
        if (cached != undefined) return cached

        const map = new Map<number, { type: string; name: string }>()
        try {
            const data = await this.fetchJson<{ result?: { id?: number; name?: string; type?: string }[] }>(
                `${NH_API}/tags/tag?sort=popular&per_page=100`
            )
            for (const tag of data.result ?? []) {
                if (tag.id != undefined && tag.name != undefined) {
                    map.set(tag.id, { type: tag.type ?? 'tag', name: tag.name })
                }
            }
        } catch {
            // An empty map just means fewer tags on the details page.
        }

        // Kept only briefly when it came back empty. Remembering a failed
        // fetch for the hour a good one gets is why a rate-limited moment
        // could leave every gallery showing no tags at all.
        this.remember('tagmap', map, map.size > 0 ? 3600000 : 60000)
        return map
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const request = App.createRequest({ url: url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 3)
        this.checkResponse(response.status)
        return JSON.parse(response.data as string) as T
    }

    /** A gallery record, reused if it was fetched moments ago. */
    private async gallery(galleryId: number | string): Promise<ApiGallery> {
        const key = `g:${galleryId}`
        const cached = this.remembered<ApiGallery>(key)
        if (cached != undefined) return cached

        const gallery = await this.fetchJson<ApiGallery>(`${NH_API}/galleries/${galleryId}`)
        this.remember(key, gallery)
        return gallery
    }

    /**
     * URL-safe form of a search query, negations included -- and English only,
     * on every search the source makes: browsing, tags, typed queries and the
     * lookups that assemble a series alike. Doing it here, once, is what keeps
     * a new caller from forgetting it the way getSearchResults did.
     */
    private searchUrl(query: string, sort: string, page: number): string {
        const english = /(^|\s)language:english\b/.test(query) ? query : `${query} language:english`
        return `${NH_API}/search?query=${encodeURIComponent(english.trim() + EXCLUSION)}&sort=${sort}&page=${page}`
    }

    /**
     * The banned tag ids, checked on every entry the API hands back even
     * though the query already negates them -- the backstop costs nothing and
     * guards against the server-side syntax ever changing under us.
     */
    private admitted(tagIds: number[] | undefined, parodies?: Set<number>): boolean {
        const ids = tagIds ?? []
        if (!ids.includes(ENGLISH_ID)) return false
        if (ids.some((id) => BANNED_IDS.has(id))) return false
        if (ids.some((id) => PARODY_ID_SET.has(id))) return false
        if (groupRefusedByIds(ids, GROUP_RULE)) return false

        // A listing entry mixes every tag type into one id list, so a parody
        // shows up here too once the parody ids are known.
        return parodies == undefined || !ids.some((id) => parodies.has(id))
    }

    /** How many pages deep the parody catalog is warmed. See parodyIds. */
    private parodyPages = 0

    /**
     * The ids of the site's best-known parodies, minus its own "original".
     *
     * A listing entry names none of its tags, only their ids, so a parody can
     * only be kept out of a listing if its id is known. The site holds 4,116
     * of them across 37 pages, which cannot be fetched at once against an
     * allowance of about ten requests a minute -- so the catalog is warmed one
     * page per listing fetch and kept for an hour.
     *
     * The depth is chosen from the site's own numbers: page 1 stops at
     * parodies with 424 galleries, which let a current-season anime parody sit
     * unfiltered on page 7. Twelve pages reach down to roughly twenty
     * galleries apiece, which covers the parodies a listing actually surfaces.
     * Rarer ones are still caught the moment the gallery is opened, where its
     * tags arrive named.
     *
     * Only listings warm the catalog. Opening a gallery must not, or the
     * no-request open -- the thing that makes this source usable at seven
     * seconds a request -- would cost a request again.
     */
    private async parodyIds(warm: boolean = false): Promise<Set<number>> {
        const cached = this.remembered<Set<number>>('parodyids')

        // The hour is up: the pages have to be gathered again, so the depth
        // counter starts over with them.
        if (cached == undefined) this.parodyPages = 0
        if (cached != undefined && (!warm || this.parodyPages >= PARODY_CATALOG_PAGES)) return cached

        const ids = cached ?? new Set<number>()
        try {
            const page = this.parodyPages + 1
            const data = await this.fetchJson<{ result?: { id?: number }[] }>(
                `${NH_API}/tags/parody?sort=popular&per_page=100&page=${page}`
            )
            const result = data.result ?? []
            for (const parody of result) {
                if (parody.id != undefined && parody.id !== ORIGINAL_PARODY_ID) ids.add(parody.id)
            }
            if (result.length > 0) this.parodyPages = page
        } catch {
            // An empty set simply leaves the details gate to do the work.
        }

        // A fetch that failed is not remembered for the hour a good one is:
        // a single rate-limited request would otherwise leave listings
        // unfiltered until it expired.
        this.remember('parodyids', ids, ids.size > 0 ? 3600000 : 60000)
        return ids
    }

    /**
     * Collapses a page of listing entries into one tile per series. The fold
     * itself is foldTiles in SeriesMerge.ts, shared with AsmHentai, so the
     * two sources merge by exactly the same rules; this holds the entries to
     * this source's own first -- English, the standing exclusions, known
     * parodies -- and remembers each, so that opening it costs no request.
     */
    private tilesFrom(entries: ApiListing[], seen: Set<string>, parodies?: Set<number>): PartialSourceManga[] {
        const items: FoldItem<ApiListing>[] = []
        for (const entry of entries) {
            if (!this.admitted(entry.tag_ids, parodies)) continue

            // The listing entry already carries the media id, page count and
            // tag ids, which is everything the details screen needs.
            this.remember(`l:${entry.id}`, entry, 1800000)

            const thumb = (entry.thumbnail ?? '').replace(/^\/+/, '')
            items.push({
                id: String(entry.id),
                raw: (entry.english_title ?? entry.japanese_title ?? `Gallery ${entry.id}`).trim(),
                thumb: thumb.length > 0 ? `${NH_THUMB_CDN}/${thumb}` : '',
                multiWork: isMultiWork(entry.tag_ids),
                payload: entry
            })
        }

        return foldTiles(items, seen, this.foldMemo).map((tile) => App.createPartialSourceManga({
            mangaId: tile.id,
            image: tile.thumb,
            title: tile.title
        }))
    }

    /** This source's memo, as the shared fold sees it. */
    private get foldMemo(): FoldMemo {
        return {
            remember: (key: string, value: unknown, ttl?: number) => this.remember(key, value, ttl),
            remembered: <V>(key: string) => this.remembered<V>(key)
        }
    }

    /**
     * Every gallery belonging to `base`, ordered by volume.
     *
     * The first search is for the name itself, which finds every volume that
     * leads with it. Everything the listing folded into the tile is added on
     * its word. Then the artist's own English catalogue is searched: that is
     * where the volumes that lead with a title of their own are -- the
     * "COSBITCH!", "Netoria" and "TotonoIki!" books of Marked-girls Origin, or
     * the first NTR Jigo Houkoku, published as "Toxic JK Netorare Jigo
     * Houkoku". Which of them belong is decided by volumeOf in SeriesMerge.ts,
     * shared with AsmHentai.
     *
     * Every result is held to the same rules as a listing -- English, the
     * standing exclusions, no parodies -- so a series never gains a chapter the
     * gate would refuse. The same book uploaded twice is listed once.
     */
    private async volumesOf(base: string): Promise<{ id: number; title: string; volume: number }[]> {
        const cacheKey = `v:${seriesKey(base)}`
        const cached = this.remembered<{ id: number; title: string; volume: number }[]>(cacheKey)
        if (cached != undefined) return cached

        const parodies = await this.parodyIds()
        const found = new Map<number, { id: number; title: string; volume: number; numbered: boolean }>()
        const books = new Set<string>()

        // Volumes of this very series that the rules refused -- what tells
        // "everything here is excluded" from "nothing was found".
        let refused = 0

        const candidate = (entry: ApiListing): { raw: string; multiWork: boolean } => ({
            raw: (entry.english_title ?? entry.japanese_title ?? '').trim(),
            multiWork: isMultiWork(entry.tag_ids)
        })

        const byName = (await this.fetchJson<{ result?: ApiListing[] }>(
            this.searchUrl(seriesQuery(base), 'date', 1)
        )).result ?? []
        const longName = isLongName(byName.map(candidate), base)

        const members: { raw: string; multiWork: boolean }[] = []
        const consider = (entries: ApiListing[], sameArtist: boolean, trusted: boolean = false): void => {
            for (const entry of entries) {
                if (found.has(entry.id)) continue

                const verdict = volumeOf(candidate(entry), base, longName, sameArtist, trusted, members)
                if (!verdict.belongs) continue

                if (!this.admitted(entry.tag_ids, parodies)) {
                    refused++
                    continue
                }
                if (books.has(verdict.book)) continue
                books.add(verdict.book)

                found.set(entry.id, { id: entry.id, title: verdict.title, volume: verdict.volume, numbered: verdict.numbered })
                members.push(candidate(entry))
            }
        }

        consider(byName, false)
        consider(foldedInto<ApiListing>(this.foldMemo, base).map((item) => item.payload), true, true)

        // Always, since listings merge a creator's volumes by their shared
        // name: a tile built that way has to open with every volume it stands
        // for. It costs one request when a series is opened, never browsing.
        if (found.size > 0) {
            try {
                const first = orderVolumes(Array.from(found.values()))[0] as { id: number }
                const tags = (await this.gallery(first.id)).tags ?? []
                const creator = tags.find((tag) => tag.type === 'artist') ?? tags.find((tag) => tag.type === 'group')

                if (creator != undefined) {
                    const byArtist = (await this.fetchJson<{ result?: ApiListing[] }>(
                        this.searchUrl(searchTermFor(`${creator.type}:${creator.name}`, false), 'date', 1)
                    )).result ?? []
                    consider(byArtist, true)
                    // Again: a volume can belong through a member the first
                    // pass found after it -- the newest volume comes first.
                    consider(byArtist, true)
                }
            } catch {
                // The name search alone still stands.
            }
        }

        const volumes = orderVolumes(Array.from(found.values()))

        // Not remembered when empty: a rate-limited search would otherwise
        // leave the entry unopenable for the whole cache lifetime.
        if (volumes.length === 0) throw new Error(nothingToShow(base, refused, true))

        this.remember(cacheKey, volumes)
        return volumes
    }

    private async pagedSearch(query: string, sort: string, page: number, seen: Set<string>): Promise<PagedResults> {
        const data = await this.fetchJson<{ result?: ApiListing[]; num_pages?: number }>(this.searchUrl(query, sort, page))

        const entries = data.result ?? []
        const tiles = this.tilesFrom(entries, seen, await this.parodyIds(true))
        const lastPage = page >= (data.num_pages ?? 1) || entries.length === 0

        return App.createPagedResults({
            results: tiles,
            metadata: lastPage ? undefined : { page: page + 1, seen: Array.from(seen) }
        })
    }

    /**
     * Resolves whichever gallery should speak for an entry: the first volume
     * of a merged series, or the gallery itself for a plain numeric id (which
     * is what a library entry from before merging, or a shared link, carries).
     */
    private async representativeId(mangaId: string): Promise<number> {
        if (!isSeriesId(mangaId)) return Number(mangaId)

        const base = baseFromSeriesId(mangaId)
        const volumes = await this.volumesOf(base)
        if (volumes.length === 0) {
            throw new Error(`No volumes found for "${base}".`)
        }
        return (volumes[0] as { id: number }).id
    }

    /**
     * Details for a gallery just seen in a listing, built entirely from the
     * remembered listing entry -- no request at all, so tapping a title opens
     * it instantly instead of waiting on an API allowance of ten a minute.
     *
     * The listing entry carries the tag ids, so the standing exclusions are
     * still enforced here. Tag names are resolved from the cached catalog, so
     * a gallery may show fewer tags than the API would list; the full set
     * appears once anything fetches the gallery itself.
     */
    private async detailsFromListing(mangaId: string): Promise<SourceManga | undefined> {
        const entry = this.remembered<ApiListing>(`l:${mangaId}`)
        if (entry == undefined) return undefined

        if (!this.admitted(entry.tag_ids, await this.parodyIds())) {
            throw new Error('This gallery carries content excluded by your settings and will not be shown.')
        }

        const names = await this.tagNames()
        const byType = new Map<string, Tag[]>()
        for (const id of entry.tag_ids ?? []) {
            const known = names.get(id)
            if (known == undefined) continue

            const list = byType.get(known.type) ?? []
            list.push(App.createTag({ id: `${known.type}:${known.name}`, label: known.name }))
            byType.set(known.type, list)
        }

        const sections: TagSection[] = []
        for (const [type, list] of byType) {
            sections.push(App.createTagSection({ id: type, label: type.charAt(0).toUpperCase() + type.slice(1), tags: list }))
        }

        const raw = (entry.english_title ?? entry.japanese_title ?? `Gallery ${mangaId}`).trim()
        const thumb = (entry.thumbnail ?? '').replace(/^\/+/, '')

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [cleanTitle(raw) || raw],
                image: thumb.length > 0 ? `${NH_THUMB_CDN}/${thumb}` : '',
                desc: `${entry.num_pages ?? '?'} pages.`,
                status: 'Completed',
                tags: sections
            })
        })
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const instant = await this.detailsFromListing(mangaId)
        if (instant != undefined) return instant

        const galleryId = await this.representativeId(mangaId)
        const gallery = await this.gallery(galleryId)

        const tags = gallery.tags ?? []
        // A merged entry is named for the series, not for whichever volume
        // happened to supply the metadata.
        const galleryTitle = (gallery.title?.pretty ?? gallery.title?.english ?? `Gallery ${mangaId}`).trim()
        const title = isSeriesId(mangaId) ? baseFromSeriesId(mangaId) : galleryTitle
        const fullTitle = (gallery.title?.english ?? galleryTitle).trim()

        const artists = tags.filter((tag) => tag.type === 'artist').map((tag) => tag.name)

        // Tag sections mirror the API's own types, the same way HentaiNexus
        // exposes its categories. Banned tags cannot appear here -- a gallery
        // carrying one refuses to open below -- so no scrubbing is needed.
        const byType = new Map<string, Tag[]>()
        for (const tag of tags) {
            const list = byType.get(tag.type) ?? []
            list.push(App.createTag({ id: `${tag.type}:${tag.name}`, label: tag.name }))
            byType.set(tag.type, list)
        }

        const sections: TagSection[] = []
        for (const [type, list] of byType) {
            sections.push(App.createTagSection({ id: type, label: type.charAt(0).toUpperCase() + type.slice(1), tags: list }))
        }

        // The gate: a gallery carrying a banned tag is refused outright, so
        // even an old bookmark or a shared link cannot open one. A parody of
        // something is refused the same way -- only the site's own "original"
        // parody is allowed through, which is what leaves original works. And
        // anything not in English, which is how a Chinese gallery already in
        // the library is kept from opening now that the source is English only.
        if (!tags.some((tag) => tag.id === ENGLISH_ID)) {
            throw new Error('This gallery is not in English and will not be shown.')
        }
        if (tags.some((tag) => BANNED_IDS.has(tag.id) || (tag.type === 'tag' && bannedTagName(tag.name)))) {
            throw new Error('This gallery carries content excluded by your settings and will not be shown.')
        }
        if (groupRefusedByIds(tags.map((tag) => tag.id), GROUP_RULE)) {
            throw new Error(GROUP_REFUSAL_MESSAGE)
        }
        if (tags.some((tag) => tag.type === 'parody' && tag.id !== ORIGINAL_PARODY_ID)) {
            throw new Error('This gallery is a parody, which your settings exclude, and will not be shown.')
        }

        const cover = (gallery.cover?.path ?? gallery.thumbnail ?? '').replace(/^\/+/, '')

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: fullTitle === title ? [title] : [title, fullTitle],
                image: cover.length > 0 ? `${NH_THUMB_CDN}/${cover}` : '',
                desc: `${gallery.num_pages ?? '?'} pages.`,
                status: 'Completed',
                author: artists.join(', '),
                tags: sections
            })
        })
    }

    /**
     * Each volume of the series becomes a chapter, keyed on its gallery id.
     *
     * Upload dates live only on a gallery's own record, never in search
     * results, so they cost one request per volume. That is affordable for the
     * handful of volumes a series here runs to, but the API allows only
     * fifteen requests a minute, so a runaway group is capped rather than
     * making the app wait minutes -- the remaining chapters simply carry no
     * date, which beats a wrong one.
     */
    async getChapters(mangaId: string): Promise<Chapter[]> {
        if (!isSeriesId(mangaId)) {
            // A gallery just seen in a listing is its own single chapter, and
            // the remembered entry says so without a request. It carries no
            // upload date, so the chapter goes undated rather than costing an
            // API call the reader would wait on.
            const listed = this.remembered<ApiListing>(`l:${mangaId}`)
            if (listed != undefined && this.remembered<ApiGallery>(`g:${mangaId}`) == undefined) {
                if (!this.admitted(listed.tag_ids, await this.parodyIds())) {
                    throw new Error('This gallery carries content excluded by your settings and will not be shown.')
                }

                const raw = (listed.english_title ?? listed.japanese_title ?? 'Gallery').trim()
                return [App.createChapter({
                    id: String(listed.id),
                    chapNum: 1,
                    name: cleanTitle(raw) || raw,
                    langCode: '🇬🇧',
                    sortingIndex: 0
                })]
            }

            const gallery = await this.gallery(mangaId)
            if (!(gallery.tags ?? []).some((tag) => tag.id === ENGLISH_ID)) {
                throw new Error('This gallery is not in English and will not be shown.')
            }
            if ((gallery.tags ?? []).some((tag) => BANNED_IDS.has(tag.id) || (tag.type === 'tag' && bannedTagName(tag.name)))) {
                throw new Error('This gallery carries content excluded by your settings and will not be shown.')
            }
            if (groupRefusedByIds((gallery.tags ?? []).map((tag) => tag.id), GROUP_RULE)) {
                throw new Error(GROUP_REFUSAL_MESSAGE)
            }
            if ((gallery.tags ?? []).some((tag) => tag.type === 'parody' && tag.id !== ORIGINAL_PARODY_ID)) {
                throw new Error('This gallery is a parody, which your settings exclude, and will not be shown.')
            }

            return [App.createChapter({
                id: String(gallery.id),
                chapNum: 1,
                name: (gallery.title?.pretty ?? gallery.title?.english ?? 'Gallery').trim(),
                time: gallery.upload_date != undefined ? new Date(gallery.upload_date * 1000) : undefined,
                langCode: '🇬🇧',
                sortingIndex: 0
            })]
        }

        const base = baseFromSeriesId(mangaId)
        const volumes = await this.volumesOf(base)
        if (volumes.length === 0) {
            throw new Error(`No volumes found for "${base}".`)
        }

        // Dates are taken only from gallery records already in hand -- opening
        // an entry fetches the first volume's record for its details, so that
        // one is dated for free. Fetching the rest would cost a request per
        // volume against a fifteen-a-minute budget, which is what made the
        // source unusable; a missing date beats an entry that never loads.
        const times: Record<number, Date | undefined> = {}
        for (const volume of volumes) {
            const cached = this.remembered<ApiGallery>(`g:${volume.id}`)
            if (cached?.upload_date != undefined) times[volume.id] = new Date(cached.upload_date * 1000)
        }

        return volumes.map((volume, index) => App.createChapter({
            id: String(volume.id),
            chapNum: volume.volume,
            name: volume.title,
            time: times[volume.id],
            langCode: '🇬🇧',
            sortingIndex: index
        }))
    }

    /**
     * The chapter id is the gallery to read. `gallery` is accepted as well,
     * the id the source handed out before volumes were merged, so an entry
     * already in the library keeps working.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const galleryId = /^\d+$/.test(chapterId) ? chapterId : String(await this.representativeId(mangaId))
        const gallery = await this.gallery(galleryId)

        const pages: string[] = []
        for (const page of gallery.pages ?? []) {
            const path = (page.path ?? '').replace(/^\/+/, '')
            if (path.length > 0) pages.push(`${NH_IMAGE_CDN}/${path}`)
        }

        if (pages.length === 0) {
            throw new Error(`No pages were returned for gallery ${galleryId}.`)
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

        // Every chosen filter becomes one of the API's own terms, with a
        // leading minus for the ones to leave out -- the same shape
        // HentaiNexus uses. A typed query rides along untouched, so
        // hand-written syntax like `artist:x` still works, and the standing
        // exclusions are appended on top of whatever is asked for.
        const terms: string[] = []
        if (title.length > 0) terms.push(title)

        for (const tag of query.includedTags ?? []) {
            terms.push(searchTermFor(tag.id, false))
        }
        for (const tag of query.excludedTags ?? []) {
            terms.push(searchTermFor(tag.id, true))
        }

        // A browse made only of exclusions needs no base term of its own any
        // more: every search carries language:english, which is the positive
        // term the API insists on.

        return this.pagedSearch(terms.join(' '), 'date', page, seen)
    }

    /**
     * Exclusion is offered: the API negates a term with a leading minus, so a
     * tag can be filtered out as easily as filtered for. The standing
     * exclusions are appended regardless and cannot be turned off.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    /**
     * The browsable catalogs, remembered for an hour: they change rarely, and
     * re-fetching them on every visit to the filter screen would eat the
     * request budget for no gain.
     *
     * Each type is fetched on its own and kept only if it arrives, so a rate
     * limit part-way through costs one section rather than the whole screen.
     * Banned tags are scrubbed from the offer -- they appear in the popular
     * list, and offering a filter that cannot return anything is worse than
     * not offering it.
     */
    async getSearchTags(): Promise<TagSection[]> {
        // No language section: the source is English only, so there is no
        // language left to choose.
        const sections: TagSection[] = []

        const bannedNames = new Set(NH_BANNED.map((tag) => tag.name.toLowerCase()))

        for (const entry of TAG_TYPES) {
            const key = `tags:${entry.type}`
            let tags = this.remembered<{ id: string; label: string }[]>(key)

            if (tags == undefined) {
                try {
                    const data = await this.fetchJson<{ result?: { name?: string; count?: number }[] }>(
                        `${NH_API}/tags/${entry.type}?sort=popular&per_page=100`
                    )

                    tags = []
                    const seen = new Set<string>()
                    for (const tag of data.result ?? []) {
                        const name = (tag.name ?? '').trim()
                        if (name.length === 0 || seen.has(name) || bannedNames.has(name.toLowerCase())) continue
                        // The whole rule, not only the sixteen named tags:
                        // "gangbang" and "furry" were on offer before.
                        if (entry.type === 'tag' && bannedTagName(name)) continue

                        seen.add(name)
                        tags.push({ id: `${entry.type}:${name}`, label: name })
                    }
                    // Alphabetical, so the list reads by name rather than by
                    // the popularity the API returns it in.
                    tags.sort((a, b) => a.label.localeCompare(b.label))
                    this.remember(key, tags, 3600000)
                } catch {
                    // Leaves the sections gathered so far in place.
                    continue
                }
            }

            if (tags.length > 0) {
                sections.push(App.createTagSection({
                    id: entry.type,
                    label: entry.label,
                    tags: tags.map((tag) => App.createTag({ id: tag.id, label: tag.label }))
                }))
            }
        }

        // No "Always Excluded" list: its "No yaoi", "No males only" entries
        // read as excluded tags on offer. The rules apply whatever is chosen.
        return sections
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

            const data = await this.fetchJson<{ result?: ApiListing[] }>(this.searchUrl('language:english', entry.sort, 1))
            // Parodies are kept off the home rows the same as everywhere else.
            // Only the first row warms the catalog, so the home screen is not
            // held up by an extra request per row.
            section.items = this.tilesFrom(data.result ?? [], new Set<string>(), await this.parodyIds(entry === SECTIONS[0]))
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        const sort = SECTIONS.find((entry) => entry.id === homepageSectionId)?.sort ?? 'date'
        return this.pagedSearch('language:english', sort, page, seen)
    }
}
