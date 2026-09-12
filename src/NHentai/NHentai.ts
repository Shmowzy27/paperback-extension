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
    { id: 8010, name: 'group' },
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
    'ttm threesome', 'gang rape', 'gangbang', 'orgy',
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

const BANNED_IDS = new Set(NH_BANNED.map((tag) => tag.id))

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
    { type: 'artist', label: 'Artists' },
    { type: 'parody', label: 'Parodies' }
]

const SECTIONS: { id: string; label: string; sort: string }[] = [
    { id: 'new', label: 'New Uploads (English)', sort: 'date' },
    { id: 'popular-week', label: 'Popular This Week (English)', sort: 'popular-week' },
    { id: 'popular', label: 'All-Time Popular (English)', sort: 'popular' }
]

/**
 * Galleries on nhentai are flat: a multi-volume work is published as several
 * separate galleries, exactly the shape HentaiNexus faces. So volumes are
 * merged into one library entry the same way -- the trailing volume number is
 * stripped off the title and what remains is the series.
 *
 * The sister sites need none of this: hentaihere and hentai2read already model
 * a series with several chapters natively.
 *
 * Every shape below was taken from real English NTR titles that failed to
 * merge -- "Mesu no Ie III ~Oyako wa…", "Ryuumon ni Shimuru Ryuuge Kouhen",
 * "Marked-girls Vol.24 Takopi no Yobigoe", "…Junior~ Part One", "NTR Jigo
 * Houkoku 2 After". A subtitle used to need a colon or a dash in front of it;
 * on this site it is as often a tilde, a quote, or nothing at all.
 */
const VOLUME = '(\\d{1,3}(?:\\.\\d{1,2})?)(?:\\s*[~\\-–]\\s*\\d{1,3}(?=\\s|$))?'
const SUBTITLE = '(?:\\s*[:\\-–—~"“「『]\\s*.*)?'
/** Anything at all may follow a number that an explicit keyword introduced. */
const ANYTHING = '(?:[\\s:\\-–—~"“「『].*)?'

/**
 * Sorts after every numbered volume. Resolved to "one past the last" once a
 * series' volumes are known, so a final chapter never reads as chapter 9999.
 */
const FINAL = 9999

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const ROMAN_NUMBERS: Record<string, number> = { II: 2, III: 3, IV: 4, VI: 6, VII: 7, VIII: 8, IX: 9 }
const JAPANESE_NUMBERS: Record<string, number> = {
    ichi: 1, ni: 2, san: 3, yon: 4, shi: 4, go: 5, roku: 6, nana: 7, shichi: 7, hachi: 8, kyuu: 9, ku: 9, juu: 10
}

/** Zenpen / Chuuhen / Kouhen (first, middle, last part), and the bound halves. */
const partNumber = (word: string): number => {
    const key = word.toLowerCase().replace(/-/g, '')
    if (key.startsWith('kanketsu')) return FINAL
    const parts: Record<string, number> = { zenpen: 1, joukan: 1, chuuhen: 1.5, chuukan: 1.5, kouhen: 2, gekan: 2 }
    return parts[key] ?? 1
}

/** A side story told after a numbered volume: "2 After" reads as 2.5. */
const AFTERWORDS = 'after\\s*story|afterstory|after|extras?|omake|bonus|epilogue|side\\s*story|special|continued|plus'

interface VolumeRule {
    pattern: RegExp
    volume: (match: RegExpExecArray) => number
}

const VOLUME_RULES: VolumeRule[] = [
    // An explicit keyword makes the number certain, so anything may follow.
    { pattern: new RegExp(`^(.*?\\S)\\s+(?:ch\\.?|chapter|vol\\.?|volume|episode|ep\\.?)\\s*${VOLUME}${ANYTHING}$`, 'i'), volume: (m) => Number(m[2]) },
    { pattern: new RegExp(`^(.*?\\S)[\\s\\-–]+(?:part|pt\\.?)\\s*${VOLUME}${ANYTHING}$`, 'i'), volume: (m) => Number(m[2]) },
    {
        pattern: new RegExp(`^(.*?\\S)[\\s\\-–]+(?:part|pt\\.?|chapter|volume|vol\\.?)\\s+(one|two|three|four|five|six|seven|eight|nine|ten)${ANYTHING}$`, 'i'),
        volume: (m) => WORD_NUMBERS[(m[2] as string).toLowerCase()] ?? 1
    },
    { pattern: new RegExp(`^(.*?\\S)\\s*#\\s*${VOLUME}${ANYTHING}$`), volume: (m) => Number(m[2]) },
    // "その2" / "Sono 2", the Japanese "part 2", on titles that carry only the
    // Japanese name. The romaji needs a space in front so "Kasono 2" is safe.
    { pattern: new RegExp(`^(.*?\\S)(?:\\s+sono|\\s*その)\\s*${VOLUME}${ANYTHING}$`, 'i'), volume: (m) => Number(m[2]) },
    // "Sakura-san Sono San" -- the same, with the number spelt out in romaji.
    {
        pattern: /^(.*?\S)\s+sono\s+(ichi|ni|san|yon|shi|go|roku|nana|shichi|hachi|kyuu|ku|juu)(?:[\s:\-–—~"“「『].*)?$/i,
        volume: (m) => JAPANESE_NUMBERS[(m[2] as string).toLowerCase()] ?? 1
    },
    // "…NTR P01~08", then "…NTR P01~012": a page range, re-uploaded as the
    // translation progresses. Each is the same book so far, so each is the
    // first volume, and the newer upload wins when duplicates are dropped.
    { pattern: /^(.*?\S)\s+P\d{1,3}\s*[~\-]\s*\d{1,3}$/, volume: () => 1 },
    // First, middle and last parts, often quoted: Zenpen, "Kouhen", Kanketsu-ban.
    {
        pattern: /^(.*?\S)(?:[\s\-–]+["“『「]?|["“『「])(zen-?pen|chuu-?hen|kou-?hen|jou-?kan|chuu-?kan|ge-?kan|kanketsu(?:-?(?:hen|ban))?)["”』」]?(?:[\s:\-–—~].*)?$/i,
        volume: (m) => partNumber(m[2] as string)
    },
    { pattern: new RegExp(`^(.*?\\S)\\s+${VOLUME}\\s*\\+?\\s*(?:${AFTERWORDS})\\b.*$`, 'i'), volume: (m) => Number(m[2]) + 0.5 },
    // Roman numerals, upper case only, so the pronoun "I" and an "x"
    // collaboration are left alone; V and X are skipped for the same reason.
    { pattern: /^(.*?\S)\s+(II|III|IV|VI|VII|VIII|IX)(?:\s*[:\-–—~"“「『].*)?$/, volume: (m) => ROMAN_NUMBERS[m[2] as string] ?? 1 },
    // A bare trailing number, with or without a separated subtitle.
    { pattern: new RegExp(`^(.*?\\S)\\s+${VOLUME}${SUBTITLE}$`), volume: (m) => Number(m[2]) },
    // "WASANBON NAGI3" -- this site frequently glues the number straight onto
    // the last word, which every whitespace-anchored pattern above misses.
    { pattern: /^(.*?[A-Za-z])(\d{1,2})$/, volume: (m) => Number(m[2]) }
]

/**
 * Where a book's own subtitle starts, for a gallery the site says belongs to a
 * series but that carries no number: "Breeding License: The … Edition".
 */
const SUBTITLE_SEPARATORS = [' - ', ' – ', ' — ', ': ', ' ~', '~ ', ' "', ' “', ' 「', ' 『']

/**
 * Titles arrive wrapped in circle, artist, language and scanlator brackets --
 * "[Circle (Artist)] Real Title 2 (Parody) [Digital]". Those are stripped
 * innermost-first and repeatedly, because a single pass leaves the outer
 * bracket of a nested pair behind and the leftover "[Circle ]" poisons the
 * series name.
 */
export const cleanTitle = (raw: string): string => {
    let text = raw
    let previous = ""
    while (previous !== text) {
        previous = text
        text = text.replace(/[\[(（][^\[\]()（）]*[\])）]/g, '')
    }

    // "English Title | 日本語タイトル" is this site's alternative-title form, and
    // the trailing half is what kept works from merging: the volume number
    // stops being the end of the string, so no pattern matches and the whole
    // Chinese or Japanese title lands in the series name. Only the leading
    // half is kept -- unless it is empty, in which case the title led with the
    // other language and that half is all there is.
    const halves = text.split('|').map((half) => half.trim()).filter((half) => half.length > 0)
    text = halves.length > 0 ? (halves[0] as string) : text

    return text.replace(/\s+/g, ' ').trim().replace(/^[-~:.\s]+|[-~:.\s]+$/g, '')
}

/**
 * `marked` says whether an entry is treated as a series at all, and that
 * decision is what keeps this source inside the API's budget: a gallery with
 * no volume number and no sign of siblings keeps its own id and opens on a
 * single request, instead of paying for a sibling search that could only ever
 * return itself.
 *
 * `numbered` says whether a volume was actually read off the title. It tells a
 * series name ("Marked-girls Collection", out of "…Collection Vol. 4") from a
 * single book's long name ("Aimai na Bokura Kanojo wa Tabun…"), which is what
 * decides whether one name continuing another makes them the same series.
 *
 * `series` is the site's own "multi-work series" tag. With it, looser shapes
 * become safe -- a number mid-title, a subtitle after a plain separator -- and
 * a gallery becomes a series even with no number at all, because the site has
 * said it has siblings. Without it, "Aimai na Bokura 2 Kanojo wa…" stays one
 * book: a number in the middle of an untagged title is as likely to be "2
 * wives" as "volume 2".
 */
export const splitTitle = (title: string, series: boolean = false): { base: string; volume: number; marked: boolean; numbered: boolean } => {
    const trimmed = cleanTitle(title)
    // The trailing period matters: "... Hanashi. Ch. 8" leaves "Hanashi."
    // behind, which would not group with a variant written without it.
    const tidy = (base: string): string => base.replace(/[\s\-–—:,.~]+$/, '').trim()

    for (const rule of VOLUME_RULES) {
        const match = rule.pattern.exec(trimmed)
        if (!match) continue

        const base = tidy(match[1] as string)
        if (base.length > 0) return { base: base, volume: rule.volume(match), marked: true, numbered: true }
    }

    if (series) {
        const mid = /^(.*?\S)\s+(\d{1,2})\s+\S/.exec(trimmed)
        if (mid) {
            const base = tidy(mid[1] as string)
            if (base.length > 0) return { base: base, volume: Number(mid[2]), marked: true, numbered: true }
        }

        // No number, but the site says there are siblings: the series name is
        // whatever comes before the book's own subtitle.
        let cut = trimmed.length
        for (const separator of SUBTITLE_SEPARATORS) {
            const at = trimmed.indexOf(separator)
            if (at >= 4 && at < cut) cut = at
        }
        const base = tidy(trimmed.slice(0, cut))
        return { base: base.length > 0 ? base : trimmed, volume: 1, marked: true, numbered: false }
    }

    return { base: trimmed.length > 0 ? trimmed : title.trim(), volume: 1, marked: false, numbered: false }
}

/**
 * A series name reduced to what identifies it: case and punctuation go, and so
 * does the difference between "Marked-girls" and "Marked Girls" -- one series
 * on this site, spelled both ways by different scanlators.
 */
export const seriesKey = (base: string): string => base.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const keyWords = (base: string): string[] => seriesKey(base).split(' ').filter((word) => word.length > 0)

/**
 * Words too common to tie two titles together on their own: particles, the
 * genre's own vocabulary, honorifics. Two NTR books that share "hitozuma no"
 * or "netorare tsuma" are not a series.
 */
const GENERIC_WORDS = new Set([
    'a', 'an', 'and', 'de', 'e', 'ga', 'her', 'his', 'in', 'is', 'ka', 'mo', 'my', 'na', 'ne', 'ni', 'no', 'o',
    'of', 'on', 'the', 'to', 'wa', 'wo', 'ya', 'yo', 'your',
    'ane', 'ban', 'chan', 'ecchi', 'gal', 'haha', 'hen', 'hitozuma', 'imouto', 'jk', 'kanojo', 'kun', 'mama',
    'musume', 'netorare', 'netorase', 'netori', 'ntr', 'onee', 'onii', 'sama', 'san', 'sensei', 'sex', 'tsuma'
])

/**
 * Particles join words; they are not words a series is named by. Counted as
 * words, "no himitsu" was a two-word match and folded "Hitozuma no Himitsu"
 * and "Kanojo no Himitsu" together -- "…no Himitsu" ("'s secret") ends half the
 * genre. So they are left out of the count.
 */
const PARTICLES = new Set([
    'a', 'an', 'and', 'de', 'e', 'ga', 'in', 'is', 'ka', 'mo', 'na', 'ne', 'ni', 'no', 'o', 'of', 'on', 'the',
    'to', 'wa', 'wo', 'ya', 'yo'
])

/**
 * A run of words distinctive enough to name a series: at least two real
 * words, and at least one of them not the genre's own vocabulary.
 */
const distinctive = (run: string[]): boolean => {
    const words = run.filter((word) => !PARTICLES.has(word))
    return words.length >= 2 && words.some((word) => word.length >= 4 && !GENERIC_WORDS.has(word) && !/^\d+$/.test(word))
}

/** One name continues the other: "Aimai na Bokura" and "Aimai na Bokura Kanojo wa…". */
export const sharesLead = (a: string, b: string): boolean => {
    const x = keyWords(a)
    const y = keyWords(b)
    const short = x.length <= y.length ? x : y
    const long = short === x ? y : x
    return distinctive(short) && short.every((word, index) => long[index] === word)
}

/**
 * The two end in the same distinctive words. On its own that would be far too
 * loose, so it is only ever asked of galleries by the same artist -- where it
 * is exactly the shape of a series whose every volume leads with a title of
 * its own: "COSBITCH! Marked-girls Origin" and "Netoria Marked-girls Origin",
 * or "Toxic JK Netorare Jigo Houkoku" and "NTR Jigo Houkoku".
 */
export const sharesTail = (a: string, b: string): boolean => {
    const x = keyWords(a)
    const y = keyWords(b)
    const run: string[] = []
    for (let offset = 1; offset <= Math.min(x.length, y.length); offset++) {
        if (x[x.length - offset] !== y[y.length - offset]) break
        run.unshift(x[x.length - offset] as string)
    }
    return distinctive(run)
}

/**
 * A whole book's title up to its own subtitle, as a series key -- or '' when
 * what is left is too generic to tell one book from another by.
 */
const bookRoot = (clean: string): string => {
    let cut = clean.length
    for (const separator of SUBTITLE_SEPARATORS) {
        const at = clean.indexOf(separator)
        if (at >= 4 && at < cut) cut = at
    }
    const root = seriesKey(clean.slice(0, cut))
    return distinctive(root.split(' ').filter((word) => word.length > 0)) ? root : ''
}

/**
 * The circle and artist a gallery is credited to, "[Marked-two (Suga Hideo)]",
 * read off the front of its raw title and normalised so "Marked-Two" and
 * "Marked-two" agree. Event prefixes such as "(C97)" come first and are
 * skipped. '' when the title credits no one.
 *
 * A listing entry carries its tags only as bare ids, so this is how two tiles
 * can be known to be the same people's work without a request.
 */
export const creatorOf = (raw: string): string => {
    const match = /^\s*(?:\([^)]*\)\s*)*\[([^\]]+)\]/.exec(raw)
    return match ? seriesKey(match[1] as string) : ''
}

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
    version: '2.3.0',
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
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${NHentaiInfo.name}> and press the cloud icon.`)
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
        // Bounded so a long browse cannot grow it without limit. The oldest
        // half goes rather than the lot, so a big listing page cannot evict
        // the tag catalogs it just paid for.
        if (this.memo.size > 400) {
            const oldest = [...this.memo.entries()]
                .sort((a, b) => a[1].at - b[1].at)
                .slice(0, 200)
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
     * Collapses the volumes on a page into one entry per series, the way
     * HentaiNexus does: the lowest-numbered volume supplies the cover, and the
     * series name is what the entry is called.
     *
     * `seen` carries the series already handed out by earlier pages, so a
     * series straddling a page boundary is not emitted twice. Its keys record
     * whether a name was read off a numbered volume (`t:`) or is one book's own
     * long name (`n:`), because that decides which way a continuing name may
     * fold: "Aimai na Bokura Kanojo wa…" folds into "Aimai na Bokura", but
     * "Marked-girls Collection" -- numbered itself, a line of its own -- must
     * never fold into "Marked-girls".
     */
    private tilesFrom(entries: ApiListing[], seen: Set<string>, parodies?: Set<number>): PartialSourceManga[] {
        // `own` is the entry a tile was made from and `folded` every other
        // entry merged into it on this page; both are handed to the series
        // when the tile is shown, so opening it gathers exactly what it stood
        // for (see foldInto).
        const series: {
            key: string; id: string; title: string; volume: number; thumb: string
            book: boolean; numbered: boolean; clean: string; creator: string; own: ApiListing; folded: ApiListing[]
        }[] = []

        for (const entry of entries) {
            if (!this.admitted(entry.tag_ids, parodies)) continue

            const raw = (entry.english_title ?? entry.japanese_title ?? `Gallery ${entry.id}`).trim()
            const { base, volume, marked, numbered } = splitTitle(raw, isMultiWork(entry.tag_ids))
            const thumb = (entry.thumbnail ?? '').replace(/^\/+/, '')
            const clean = cleanTitle(raw) || raw
            const creator = creatorOf(raw)

            // Whether this name is one book's own full title, as opposed to a
            // series name -- read off a numbered volume, or cut from a longer
            // title at its subtitle ("Ano Hi, Sunao ni…" out of "Ano Hi, Sunao
            // ni… - If only I could…"). A book's name folds into the series
            // name it continues; a series name never folds into another.
            const book = !numbered && seriesKey(base) === seriesKey(clean)

            // A numbered gallery, or one the site tags as part of a multi-work
            // series, becomes a series: it is the one that can have siblings
            // worth looking up. Any other gallery keeps its own id, which is
            // what lets it open on a single request.
            //
            // Both kinds are still keyed on the title, so the several galleries
            // this site carries of one unnumbered work collapse to a single
            // tile instead of filling the page with repeats.
            const key = seriesKey(base)
            const id = marked ? `s:${base}` : String(entry.id)
            const title = marked ? base : clean

            // The listing entry is kept so that opening this gallery costs no
            // request at all: it already carries the media id, page count and
            // tag ids, which is everything the details screen needs.
            this.remember(`l:${entry.id}`, entry, 1800000)

            const same = series.find((other) => other.key === key)
            if (same != undefined) {
                // The lowest-numbered volume on the page supplies the cover.
                if (volume < same.volume) {
                    same.volume = volume
                    same.thumb = thumb
                }
                same.folded.push(entry)
                continue
            }
            if (seen.has(`t:${key}`) || seen.has(`n:${key}`)) {
                this.foldInto(this.remembered<string>(`k:t:${key}`) ?? this.remembered<string>(`k:n:${key}`), [entry])
                continue
            }

            // A book's root is its title up to its own subtitle. Two books with
            // one root are one book uploaded twice -- "Boku no Mizugi ga
            // Kakusarete" and "… - My Swimsuit Got Stolen" -- and the root is
            // remembered across pages, because the pair is as likely to be a
            // page apart as side by side.
            const root = book ? bookRoot(clean) : ''
            if (root.length > 0) {
                if (seen.has(`r:${root}`)) continue
                seen.add(`r:${root}`)
            }

            // One name continuing another. A book's own name folds into the
            // series name it continues; a series name never folds into another,
            // which is what keeps "Marked-girls Collection" beside "Marked-girls".
            let folded = false
            for (const other of series) {
                if (!sharesLead(other.key, key)) continue

                if (key.length > other.key.length && book && !other.book) {
                    folded = true
                } else if (key.length < other.key.length && !book && other.book) {
                    // The page led with the opener's long name; the series it
                    // belongs to takes the tile over.
                    other.key = key
                    other.id = `s:${base}`
                    other.title = base
                    other.book = false
                    other.clean = clean
                    if (volume < other.volume) {
                        other.volume = volume
                        other.thumb = thumb
                    }
                    folded = true
                } else if (book && other.book) {
                    // Two names that are each a whole book fold only when they
                    // share a root. "Hitozuma Kyoushi" and "Hitozuma Kyoushi no
                    // Himitsu" have different roots: two books, and they stay two.
                    folded = root.length > 0 && bookRoot(other.clean) === root
                }
                if (folded) {
                    other.folded.push(entry)
                    break
                }
            }
            if (!folded) {
                for (const emitted of seen) {
                    // Roots and creator records are records of their own, not
                    // names to fold into.
                    if (emitted.startsWith('r:') || emitted.startsWith('a:')) continue
                    const other = emitted.slice(2)
                    if (!sharesLead(other, key)) continue

                    // Already on screen from an earlier page, either as the
                    // series this continues or as the opener that will gather
                    // this volume when it is opened.
                    const otherIsBook = emitted.startsWith('n:')
                    if ((key.length > other.length && book && !otherIsBook)
                        || (key.length < other.length && !book && otherIsBook)) {
                        this.foldInto(this.remembered<string>(`k:${emitted}`), [entry])
                        folded = true
                        break
                    }
                }
            }

            // Same creator, related names: one series. Two relations count.
            //
            // The same distinctive ending, every volume leading with a title of
            // its own -- "Netoria Marked-girls Origin" and "pa:Costa Del Sol
            // Marked girls Origin", or "Toxic JK Netorare Jigo Houkoku" and "NTR
            // Jigo Houkoku 2 After".
            //
            // The same distinctive start, the longer name continuing the shorter
            // with an arc or a book of its own -- "Tonari no Ayane-san" and
            // "Tonari no Ayane-san Desaki Battari Hen". The site tags only some
            // of these as a multi-work series, so the credit decides, not the
            // tag. A longer name numbered in its own right is a line of its own
            // -- "Marked-girls Collection Vol. 3" beside "Marked-girls" -- and
            // stays apart.
            //
            // Either relation alone would be far too loose -- "…Choukyou Nikki"
            // ends any number of unrelated books -- so the credit has to match.
            const continues = (shortKey: string, longKey: string, longNumbered: boolean): boolean =>
                shortKey.length < longKey.length && !longNumbered && sharesLead(shortKey, longKey)

            if (!folded && creator.length > 0) {
                const other = series.find((candidate) => candidate.creator === creator
                    && (sharesTail(candidate.key, key)
                        || continues(candidate.key, key, numbered)
                        || continues(key, candidate.key, candidate.numbered)))
                if (other != undefined) {
                    if (continues(key, other.key, other.numbered)) {
                        // This name is the series the tile's own name continues.
                        // The tile takes it, so that opening finds both: a search
                        // for the shorter name matches the longer one too.
                        other.key = key
                        other.id = `s:${base}`
                        other.title = base
                        other.numbered = numbered
                    } else if (!other.id.startsWith('s:')) {
                        // The merged tile has to open as a series: a bare gallery
                        // id opens as the one book it names. When the tile is the
                        // shorter name, it stays the name.
                        const takeThis = marked && !continues(other.key, key, numbered)
                        other.id = takeThis ? `s:${base}` : `s:${other.title}`
                        if (takeThis) other.title = base
                    }
                    other.book = false
                    if (volume < other.volume) {
                        other.volume = volume
                        other.thumb = thumb
                    }
                    other.folded.push(entry)
                    folded = true
                } else {
                    // A series tile from an earlier page already stands for this
                    // one. Only series tiles are recorded: a plain gallery shown
                    // earlier cannot be turned into its series after the fact,
                    // so in that order the series tile still has to appear.
                    //
                    // Either relation counts, though only one way round for a
                    // continuing name: this one continuing an earlier series.
                    // An earlier tile whose name continues this one is already
                    // on screen under the longer name, and cannot be renamed.
                    const prefix = `a:${creator}|`
                    for (const emitted of seen) {
                        if (!emitted.startsWith(prefix)) continue
                        const earlier = emitted.slice(prefix.length)
                        if (sharesTail(earlier, key) || continues(earlier, key, numbered)) {
                            this.foldInto(this.remembered<string>(`k:${emitted}`), [entry])
                            folded = true
                            break
                        }
                    }
                }
            }
            if (folded) continue

            series.push({
                key: key, id: id, title: title, volume: volume, thumb: thumb,
                book: book, numbered: numbered, clean: clean, creator: creator, own: entry, folded: []
            })
        }

        const tiles: PartialSourceManga[] = []
        for (const entry of series) {
            const key = `${entry.book ? 'n' : 't'}:${entry.key}`
            if (seen.has(key)) continue
            seen.add(key)

            // A series tile hands everything folded into it to the series it
            // opens as, and the records a later page's fold is matched against
            // learn which series they stand for.
            if (entry.id.startsWith('s:')) {
                const tileKey = seriesKey(entry.id.slice(2))
                this.foldInto(tileKey, [entry.own, ...entry.folded])
                this.remember(`k:${key}`, tileKey, 1800000)
                if (entry.creator.length > 0) {
                    const record = `a:${entry.creator}|${entry.key}`
                    seen.add(record)
                    this.remember(`k:${record}`, tileKey, 1800000)
                }
            }

            tiles.push(App.createPartialSourceManga({
                mangaId: entry.id,
                image: entry.thumb.length > 0 ? `${NH_THUMB_CDN}/${entry.thumb}` : '',
                title: entry.title
            }))
        }

        return tiles
    }

    /**
     * Hands listing entries to the series a tile opens as, remembered under the
     * series' key -- which is where volumesOf looks -- for half an hour, the
     * same as the listing entries themselves.
     */
    private foldInto(tileKey: string | undefined, entries: ApiListing[]): void {
        if (tileKey == undefined || entries.length === 0) return

        const list = this.remembered<ApiListing[]>(`f:${tileKey}`) ?? []
        for (const entry of entries) {
            if (!list.some((known) => known.id === entry.id)) list.push(entry)
        }
        this.remember(`f:${tileKey}`, list, 1800000)
    }

    /**
     * Every gallery belonging to `base`, ordered by volume.
     *
     * The first search is for the name itself, which finds every volume that
     * leads with it. Then the artist's own English catalogue is searched as
     * well: that is where the volumes that lead with a title of their own are
     * -- the "COSBITCH!", "Netoria" and "TotonoIki!" books of Marked-girls
     * Origin, or the first NTR Jigo Houkoku, published as "Toxic JK Netorare
     * Jigo Houkoku". From there a gallery joins only if its name ends in the
     * same distinctive words, which keeps the circle's other lines apart.
     *
     * Every result is held to the same rules as a listing -- English, the
     * standing exclusions, no parodies -- so a series never gains a chapter the
     * gate would refuse. The same book uploaded twice, two scanlations of one
     * volume, is listed once, the newer upload kept.
     */
    private async volumesOf(base: string): Promise<{ id: number; title: string; volume: number }[]> {
        const wanted = seriesKey(base)
        const cacheKey = `v:${wanted}`
        const cached = this.remembered<{ id: number; title: string; volume: number }[]>(cacheKey)
        if (cached != undefined) return cached

        const parodies = await this.parodyIds()
        const found = new Map<number, { id: number; title: string; volume: number; multiWork: boolean }>()
        const books = new Set<string>()

        const byName = (await this.fetchJson<{ result?: ApiListing[] }>(
            this.searchUrl(seriesQuery(base), 'date', 1)
        )).result ?? []

        // Whether `base` is one book's own long name rather than a series name
        // read off numbered volumes. Only then may a shorter numbered name --
        // the series that book opens -- be gathered into it.
        const longName = byName.some((entry) => {
            const raw = (entry.english_title ?? entry.japanese_title ?? '').trim()
            return seriesKey(cleanTitle(raw) || raw) === wanted && !splitTitle(raw, isMultiWork(entry.tag_ids)).numbered
        })

        // Volumes of this very series that the rules refused. It is what tells
        // "everything here is excluded" from "nothing was found", which matters
        // for an entry already in the library: both used to read as "No volumes
        // found", which looks like a fault rather than the rules at work.
        let refused = 0

        const consider = (entries: ApiListing[], sameArtist: boolean): void => {
            for (const entry of entries) {
                if (found.has(entry.id)) continue

                const raw = (entry.english_title ?? entry.japanese_title ?? '').trim()
                const split = splitTitle(raw, isMultiWork(entry.tag_ids))
                const key = seriesKey(split.base)

                // A longer name continuing `base` belongs unless it is numbered in
                // its own right, a line of its own. A shorter name belongs only
                // when `base` is one book's long name that continues it -- and,
                // unnumbered, only from the artist's own works: "Tonari no
                // Ayane-san Desaki Battari Hen" reaching back to "Tonari no
                // Ayane-san", the series its arc belongs to.
                let belongs = key === wanted
                if (!belongs && sharesLead(key, wanted)) {
                    belongs = key.length > wanted.length ? !split.numbered : (longName && (split.numbered || sameArtist))
                }
                if (!belongs && sameArtist) belongs = sharesTail(key, wanted)
                if (!belongs) continue

                if (!this.admitted(entry.tag_ids, parodies)) {
                    refused++
                    continue
                }

                const title = cleanTitle(raw) || raw
                const book = `${split.volume}|${seriesKey(title)}`
                if (books.has(book)) continue
                books.add(book)

                found.set(entry.id, { id: entry.id, title: title, volume: split.volume, multiWork: isMultiWork(entry.tag_ids) })
            }
        }

        consider(byName, false)

        // Every gallery the listing folded into this tile. The artist search
        // below reads one page, the artist's twenty-five newest works; for a
        // circle as prolific as Marked-two, the older Origin volumes are past
        // it -- and a volume the listing had folded away, but that the open
        // could not find, simply vanished. What a tile stood for in the listing
        // is what it opens with, at no cost: the entries are already in hand.
        consider(this.remembered<ApiListing[]>(`f:${wanted}`) ?? [], true)

        // Always, now that listings merge a creator's volumes by their shared
        // ending: a tile built that way has to open with every volume it stands
        // for, even when its own name search already found two. It costs one
        // request when a series is opened, never while browsing.
        if (found.size > 0) {
            try {
                const first = Array.from(found.values()).sort((a, b) => a.volume - b.volume)[0] as { id: number }
                const tags = (await this.gallery(first.id)).tags ?? []
                const creator = tags.find((tag) => tag.type === 'artist') ?? tags.find((tag) => tag.type === 'group')

                if (creator != undefined) {
                    const byArtist = (await this.fetchJson<{ result?: ApiListing[] }>(
                        this.searchUrl(searchTermFor(`${creator.type}:${creator.name}`, false), 'date', 1)
                    )).result ?? []
                    consider(byArtist, true)
                }
            } catch {
                // The name search alone still stands.
            }
        }

        const volumes = Array.from(found.values())
            .sort((a, b) => a.volume - b.volume || a.id - b.id)
            .map((volume) => ({ id: volume.id, title: volume.title, volume: volume.volume }))

        // A final part ("Kanketsu-ban") is numbered one past the last volume.
        let next = volumes.filter((volume) => volume.volume < FINAL)
            .reduce((highest, volume) => Math.max(highest, Math.floor(volume.volume)), 0) + 1
        for (const volume of volumes) {
            if (volume.volume >= FINAL) volume.volume = next++
        }

        // Not remembered when empty: a rate-limited search would otherwise
        // leave the entry unopenable for the whole cache lifetime.
        //
        // Usually the two causes cannot be told apart: every search already
        // negates the excluded tags, so the site never returns an excluded
        // volume for the source to see and refuse. Then the message names both
        // rules, because either may be why -- and neither is a fault.
        if (volumes.length === 0) {
            throw new Error(refused > 0
                ? `Every volume of "${base}" is left out by your settings (an excluded tag or a parody), so it will not be shown.`
                : `No volumes of "${base}" can be shown: this source shows English galleries only, and leaves out anything your settings exclude.`)
        }

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
        if (tags.some((tag) => BANNED_IDS.has(tag.id))) {
            throw new Error('This gallery carries content excluded by your settings and will not be shown.')
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
            if ((gallery.tags ?? []).some((tag) => BANNED_IDS.has(tag.id))) {
                throw new Error('This gallery carries content excluded by your settings and will not be shown.')
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

        // Shown so the standing exclusions are visible in the filter UI;
        // selecting one cannot bring the content back.
        sections.push(App.createTagSection({
            id: 'excluded',
            label: 'Always Excluded',
            tags: NH_BANNED.map((tag) => App.createTag({ id: `x-${tag.id}`, label: `No ${tag.name}` }))
        }))

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
