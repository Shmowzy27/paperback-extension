/**
 * Series merging for the doujinshi sources -- nhentai, AsmHentai, HentaiNexus.
 *
 * These sites publish a multi-volume work as separate galleries and keep no
 * series field, so a series is read off the titles. The rules started life in
 * the nhentai source and were copied into AsmHentai, where the copy fell
 * behind: fixes kept landing in one and not the other. They live here now,
 * once, and every source imports them.
 *
 * Everything in this file is pure -- no requests, no App factories -- so it can
 * be tested offline and shared freely. Each source still does its own fetching
 * and its own content rules (language, standing exclusions, parodies).
 */

// ---------------------------------------------------------------------------
// Volume numbers
// ---------------------------------------------------------------------------

/**
 * Every shape below was taken from real English titles that failed to merge --
 * "Mesu no Ie III ~Oyako wa…", "Ryuumon ni Shimuru Ryuuge Kouhen",
 * "Marked-girls Vol.24 Takopi no Yobigoe", "…Junior~ Part One", "NTR Jigo
 * Houkoku 2 After". A subtitle used to need a colon or a dash in front of it;
 * on these sites it is as often a tilde, a quote, or nothing at all.
 */
const VOLUME = '(\\d{1,3}(?:\\.\\d{1,2})?)(?:\\s*[~\\-–]\\s*\\d{1,3}(?=\\s|$))?'
const SUBTITLE = '(?:\\s*[:\\-–—~"“「『]\\s*.*)?'
/** Anything at all may follow a number that an explicit keyword introduced. */
const ANYTHING = '(?:[\\s:\\-–—~"“「『].*)?'

/**
 * Sorts after every numbered volume. Resolved to "one past the last" once a
 * series' volumes are known (see orderVolumes), so a final chapter never reads
 * as chapter 9999.
 */
export const FINAL = 9999

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

/**
 * "WASANBON NAGI3" -- the number is often glued straight onto the last word,
 * which every whitespace-anchored pattern misses. Right for doujinshi titles;
 * wrong for HentaiNexus's English ones, where "Room404" is a name, so a source
 * can leave it out (see splitClean's `glued`).
 */
const GLUED_RULE: VolumeRule = { pattern: /^(.*?[A-Za-z])(\d{1,2})$/, volume: (m) => Number(m[2]) }

const VOLUME_RULES: VolumeRule[] = [
    // "… Season 3 ep.4: Subtitle", from HentaiNexus. Season and episode fold
    // into one number so every season of a work lands in one series: season 3
    // episode 4 is 3.04 -- a hundredth, not a tenth, so episode 10 still sorts
    // after episode 9. Tried first, or the episode keyword below would stop at
    // the season and leave "… Season 3" as the series name.
    {
        pattern: new RegExp(`^(.*?\\S)\\s+season\\s*(\\d{1,2})\\s*(?:ep\\.?|episode)\\s*(\\d{1,3})${SUBTITLE}$`, 'i'),
        volume: (m) => Number(m[2]) + Number(m[3]) / 100
    },
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
    GLUED_RULE
]

/**
 * Where a book's own subtitle starts, for a gallery the site says belongs to a
 * series but that carries no number: "Breeding License: The … Edition".
 */
export const SUBTITLE_SEPARATORS = [' - ', ' – ', ' — ', ': ', ' ~', '~ ', ' "', ' “', ' 「', ' 『']

/**
 * Titles arrive wrapped in circle, artist, language and scanlator brackets --
 * "[Circle (Artist)] Real Title 2 (Parody) [Digital]". Those are stripped
 * innermost-first and repeatedly, because a single pass leaves the outer
 * bracket of a nested pair behind and the leftover "[Circle ]" poisons the
 * series name.
 */
export const cleanTitle = (raw: string): string => {
    let text = raw
    let previous = ''
    while (previous !== text) {
        previous = text
        text = text.replace(/[\[(（][^\[\]()（）]*[\])）]/g, '')
    }

    // "English Title | 日本語タイトル" is the alternative-title form, and the
    // trailing half is what kept works from merging: the volume number stops
    // being the end of the string, so no pattern matches and the whole Chinese
    // or Japanese title lands in the series name. Only the leading half is kept
    // -- unless it is empty, in which case the title led with the other
    // language and that half is all there is.
    const halves = text.split('|').map((half) => half.trim()).filter((half) => half.length > 0)
    text = halves.length > 0 ? (halves[0] as string) : text

    return text.replace(/\s+/g, ' ').trim().replace(/^[-~:.\s]+|[-~:.\s]+$/g, '')
}

export interface TitleSplit {
    base: string
    volume: number
    marked: boolean
    numbered: boolean
}

/**
 * The split itself, on a title that is already clean. HentaiNexus titles carry
 * no credit brackets, and a parenthesis there is part of the name, so that
 * source splits its titles as they are.
 *
 * `marked` says whether an entry is treated as a series at all. A gallery with
 * no volume number and no sign of siblings keeps its own id and opens as one
 * book, instead of paying for a sibling search that could only return itself.
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
export const splitClean = (trimmed: string, series: boolean = false, glued: boolean = true): TitleSplit => {
    // The trailing period matters: "... Hanashi. Ch. 8" leaves "Hanashi."
    // behind, which would not group with a variant written without it.
    const tidy = (base: string): string => base.replace(/[\s\-–—:,.~]+$/, '').trim()

    for (const rule of VOLUME_RULES) {
        if (!glued && rule === GLUED_RULE) continue
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

    return { base: trimmed, volume: 1, marked: false, numbered: false }
}

/** A raw title, credits and all, split into its series and volume. */
export const splitTitle = (title: string, series: boolean = false): TitleSplit => {
    const trimmed = cleanTitle(title)
    const split = splitClean(trimmed.length > 0 ? trimmed : title.trim(), series)
    return split
}

// ---------------------------------------------------------------------------
// Comparing names
// ---------------------------------------------------------------------------

/**
 * A series name reduced to what identifies it: case and punctuation go, and so
 * does the difference between "Marked-girls" and "Marked Girls" -- one series,
 * spelled both ways by different scanlators.
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
 * loose, so it is only ever asked of galleries by the same creator -- where it
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
export const bookRoot = (clean: string): string => {
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
 * A listing card carries no named creator, so this is how two tiles can be
 * known to be the same people's work without a request.
 */
export const creatorOf = (raw: string): string => {
    const match = /^\s*(?:\([^)]*\)\s*)*\[([^\]]+)\]/.exec(raw)
    return match ? seriesKey(match[1] as string) : ''
}

// ---------------------------------------------------------------------------
// Folding a listing into one tile per series
// ---------------------------------------------------------------------------

export const SERIES_PREFIX = 's:'

/** What a source keeps between requests; the fold's records live there. */
export interface FoldMemo {
    remember(key: string, value: unknown, ttl?: number): void
    remembered<V>(key: string): V | undefined
}

/**
 * One listing card, as the fold sees it. `payload` is whatever the source
 * wants back when a tile is opened -- a listing entry, a card row.
 */
export interface FoldItem<T> {
    id: string
    raw: string
    thumb: string
    multiWork: boolean
    payload: T
}

export interface FoldTile {
    id: string
    title: string
    thumb: string
}

/** Half an hour, the same as the listing entries themselves. */
const FOLD_TTL = 1800000

/** Everything the listing folded into the series named `base`. */
export const foldedInto = <T>(memo: FoldMemo, base: string): FoldItem<T>[] =>
    memo.remembered<FoldItem<T>[]>(`f:${seriesKey(base)}`) ?? []

/**
 * Collapses a page of listing cards into one tile per series.
 *
 * `seen` carries what earlier pages handed out, so a series straddling a page
 * boundary is not emitted twice, and so a later page can fold into a tile
 * already on screen. Its records say what kind of name a tile shows -- a series
 * name (`t:`) or one book's own full title (`n:`) -- because that decides which
 * way a continuing name may fold: "Aimai na Bokura Kanojo wa…" folds into
 * "Aimai na Bokura", but "Marked-girls Collection", numbered itself, never
 * folds into "Marked-girls".
 *
 * Every gallery folded into a tile is handed to the series it opens as
 * (`foldedInto`), so opening a tile gathers exactly what it stood for -- a
 * merge must never hide a volume.
 */
export const foldTiles = <T>(items: FoldItem<T>[], seen: Set<string>, memo: FoldMemo): FoldTile[] => {
    const series: {
        key: string; id: string; title: string; volume: number; thumb: string
        book: boolean; numbered: boolean; clean: string; creator: string
        own: FoldItem<T>; folded: FoldItem<T>[]
    }[] = []

    // A single book already on screen is recorded as `#id`; it opens as itself
    // and has nothing to hand on.
    const foldInto = (tileRef: string | undefined, more: FoldItem<T>[]): void => {
        if (tileRef == undefined || tileRef.startsWith('#') || more.length === 0) return
        const list = memo.remembered<FoldItem<T>[]>(`f:${tileRef}`) ?? []
        for (const item of more) {
            if (!list.some((known) => known.id === item.id)) list.push(item)
        }
        memo.remember(`f:${tileRef}`, list, FOLD_TTL)
    }

    // Recorded under its creator and its own series key, so that a later
    // page's fold can find the tile through any gallery it holds.
    const recordMember = (item: FoldItem<T>, tileRef: string | undefined): void => {
        if (tileRef == undefined) return
        const creator = creatorOf(item.raw)
        if (creator.length === 0) return

        const split = splitTitle(item.raw, item.multiWork)
        const record = `a:${creator}|${seriesKey(split.base)}`
        seen.add(record)
        memo.remember(`k:${record}`, tileRef, FOLD_TTL)
        memo.remember(`q:${record}`, split.numbered, FOLD_TTL)
    }

    // A single book already on screen, handed to a series shown after it, so
    // the series opens with the book it follows.
    const adopt = (tileKey: string, ref: string): void => {
        const book = memo.remembered<FoldItem<T>>(`i:${ref.slice(1)}`)
        if (book != undefined) foldInto(tileKey, [book])
    }

    // Two titles credited to the same creator, the longer name continuing the
    // shorter with an arc or a book of its own. A longer name numbered in its
    // own right is a line of its own and does not count.
    const continues = (shortKey: string, longKey: string, longNumbered: boolean): boolean =>
        shortKey.length < longKey.length && !longNumbered && sharesLead(shortKey, longKey)

    for (const item of items) {
        const { base, volume, marked, numbered } = splitTitle(item.raw, item.multiWork)
        const clean = cleanTitle(item.raw) || item.raw
        const creator = creatorOf(item.raw)

        // Whether this name is one book's own full title, as opposed to a
        // series name -- read off a numbered volume, or cut from a longer
        // title at its subtitle. A book's name folds into the series name it
        // continues; a series name never folds into another.
        const book = !numbered && seriesKey(base) === seriesKey(clean)

        // A numbered gallery, or one the site tags as part of a multi-work
        // series, becomes a series. Any other keeps its own id and opens as
        // the one book it is -- but is still keyed on its title, so several
        // uploads of one book collapse to a single tile.
        const key = seriesKey(base)
        const id = marked ? `${SERIES_PREFIX}${base}` : item.id
        const title = marked ? base : clean
        const thumb = item.thumb

        memo.remember(`i:${item.id}`, item, FOLD_TTL)

        const same = series.find((other) => other.key === key)
        if (same != undefined) {
            // The lowest-numbered volume on the page supplies the cover.
            if (volume < same.volume) {
                same.volume = volume
                same.thumb = thumb
            }
            same.folded.push(item)
            continue
        }
        if (seen.has(`t:${key}`) || seen.has(`n:${key}`)) {
            const tileRef = memo.remembered<string>(`k:t:${key}`) ?? memo.remembered<string>(`k:n:${key}`)
            foldInto(tileRef, [item])
            recordMember(item, tileRef)
            continue
        }

        // A book's root is its title up to its own subtitle. Two books with one
        // root are one book uploaded twice -- "Boku no Mizugi ga Kakusarete"
        // and "… - My Swimsuit Got Stolen" -- remembered across pages, because
        // the pair is as likely to be a page apart as side by side.
        const root = book ? bookRoot(clean) : ''
        if (root.length > 0) {
            if (seen.has(`r:${root}`)) continue
            seen.add(`r:${root}`)
        }

        // One name continuing another, on this page.
        let folded = false
        for (const other of series) {
            if (!sharesLead(other.key, key)) continue

            if (key.length > other.key.length && book && !other.book) {
                folded = true
            } else if (key.length < other.key.length && !book && other.book) {
                // The page led with the opener's long name; the series it
                // belongs to takes the tile over.
                other.key = key
                other.id = `${SERIES_PREFIX}${base}`
                other.title = base
                other.book = false
                other.clean = clean
                if (volume < other.volume) {
                    other.volume = volume
                    other.thumb = thumb
                }
                folded = true
            } else if (book && other.book) {
                // Two whole-book names fold only when they share a root.
                folded = root.length > 0 && bookRoot(other.clean) === root
            }
            if (folded) {
                other.folded.push(item)
                break
            }
        }

        // …or with a tile already on screen from an earlier page.
        if (!folded) {
            for (const emitted of seen) {
                if (emitted.startsWith('r:') || emitted.startsWith('a:')) continue
                const other = emitted.slice(2)
                if (!sharesLead(other, key)) continue

                const otherIsBook = emitted.startsWith('n:')
                if ((key.length > other.length && book && !otherIsBook)
                    || (key.length < other.length && !book && otherIsBook)) {
                    const tileRef = memo.remembered<string>(`k:${emitted}`)
                    if (tileRef != undefined && tileRef.startsWith('#')) {
                        // A single book is on screen and cannot become a series
                        // after the fact; skipping this one would lose the
                        // series behind it, so it is shown, taking the book.
                        if (marked) adopt(seriesKey(base), tileRef)
                        break
                    }
                    foldInto(tileRef, [item])
                    recordMember(item, tileRef)
                    folded = true
                    break
                }
            }
        }

        // Same creator, related names: one series -- a shared distinctive
        // ending ("Netoria Marked-girls Origin" and "pa:Costa Del Sol Marked
        // girls Origin"), or one name continuing the other ("Tonari no
        // Ayane-san" and "… Desaki Battari Hen"). Either alone would be far too
        // loose -- "…Choukyou Nikki" ends any number of unrelated books -- so
        // the credit has to match. The site's tag need not be present.
        if (!folded && creator.length > 0) {
            const other = series.find((candidate) => candidate.creator === creator
                && (sharesTail(candidate.key, key)
                    || continues(candidate.key, key, numbered)
                    || continues(key, candidate.key, candidate.numbered)))
            if (other != undefined) {
                if (continues(key, other.key, other.numbered)) {
                    // This name is the series the tile's own name continues.
                    other.key = key
                    other.id = `${SERIES_PREFIX}${base}`
                    other.title = base
                    other.numbered = numbered
                } else if (!other.id.startsWith(SERIES_PREFIX)) {
                    // A merged tile has to open as a series.
                    const takeThis = marked && !continues(other.key, key, numbered)
                    other.id = takeThis ? `${SERIES_PREFIX}${base}` : `${SERIES_PREFIX}${other.title}`
                    if (takeThis) other.title = base
                }
                other.book = false
                if (volume < other.volume) {
                    other.volume = volume
                    other.thumb = thumb
                }
                other.folded.push(item)
                folded = true
            } else {
                // A tile from an earlier page, in either direction. An earlier
                // series tile takes this one in; an earlier single book cannot,
                // so this one is shown as the series and takes the book with it.
                const prefix = `a:${creator}|`
                for (const emitted of seen) {
                    if (!emitted.startsWith(prefix)) continue
                    const earlier = emitted.slice(prefix.length)
                    const earlierNumbered = memo.remembered<boolean>(`q:${emitted}`) ?? true
                    if (!(sharesTail(earlier, key) || continues(earlier, key, numbered) || continues(key, earlier, earlierNumbered))) continue

                    const tileRef = memo.remembered<string>(`k:${emitted}`)
                    if (tileRef != undefined && tileRef.startsWith('#')) {
                        if (marked) adopt(seriesKey(base), tileRef)
                    } else {
                        foldInto(tileRef, [item])
                        recordMember(item, tileRef)
                        folded = true
                    }
                    break
                }
            }
        }
        if (folded) continue

        series.push({
            key: key, id: id, title: title, volume: volume, thumb: thumb,
            book: book, numbered: numbered, clean: clean, creator: creator, own: item, folded: []
        })
    }

    const tiles: FoldTile[] = []
    for (const entry of series) {
        const key = `${entry.book ? 'n' : 't'}:${entry.key}`
        if (seen.has(key)) continue
        seen.add(key)

        // Records a later page's fold is matched against, saying what the tile
        // stands for: a series tile, its series' key; a single book, its id.
        const isSeries = entry.id.startsWith(SERIES_PREFIX)
        const tileRef = isSeries ? seriesKey(entry.id.slice(SERIES_PREFIX.length)) : `#${entry.id}`
        if (isSeries) foldInto(tileRef, [entry.own, ...entry.folded])
        memo.remember(`k:${key}`, tileRef, FOLD_TTL)
        if (entry.creator.length > 0) {
            const record = `a:${entry.creator}|${entry.key}`
            seen.add(record)
            memo.remember(`k:${record}`, tileRef, FOLD_TTL)
            memo.remember(`q:${record}`, entry.numbered, FOLD_TTL)
        }
        // Every gallery the tile holds is a member, not only the name it shows:
        // a tile named for one arc that took in the series name must be
        // findable by that name, since the next arc continues it.
        for (const member of isSeries ? [entry.own, ...entry.folded] : [entry.own]) {
            recordMember(member, tileRef)
        }

        tiles.push({ id: entry.id, title: entry.title, thumb: entry.thumb })
    }

    return tiles
}

// ---------------------------------------------------------------------------
// Gathering a series when it is opened
// ---------------------------------------------------------------------------

export interface SeriesCandidate {
    raw: string
    multiWork: boolean
}

/**
 * Whether `base` is one book's own long name rather than a series name read
 * off numbered volumes -- decided from the galleries its name search returned.
 * Only then may a shorter name, the series that book belongs to, be gathered
 * into it.
 */
export const isLongName = (candidates: SeriesCandidate[], base: string): boolean => {
    const wanted = seriesKey(base)
    return candidates.some((candidate) => {
        const clean = cleanTitle(candidate.raw) || candidate.raw
        return seriesKey(clean) === wanted && !splitTitle(candidate.raw, candidate.multiWork).numbered
    })
}

/**
 * Whether a gallery found while gathering `base` is one of its volumes.
 *
 * Its own name, or a longer name continuing `base` that is not numbered in its
 * own right. A shorter name only when `base` is one book's long name continuing
 * it -- and, unnumbered, only from the artist's own works ("Tonari no Ayane-san
 * Desaki Battari Hen" reaching back to "Tonari no Ayane-san"). A shared ending
 * only from the artist's own works. `trusted` is a gallery the listing itself
 * folded into the tile, taken on its word.
 *
 * `book` identifies the same book uploaded twice, so it is listed once.
 */
export const volumeOf = (
    candidate: SeriesCandidate, base: string, longName: boolean, sameArtist: boolean, trusted: boolean = false
): { belongs: boolean; volume: number; title: string; book: string } => {
    const wanted = seriesKey(base)
    const split = splitTitle(candidate.raw, candidate.multiWork)
    const key = seriesKey(split.base)

    let belongs = trusted || key === wanted
    if (!belongs && sharesLead(key, wanted)) {
        belongs = key.length > wanted.length ? !split.numbered : (longName && (split.numbered || sameArtist))
    }
    if (!belongs && sameArtist) belongs = sharesTail(key, wanted)

    const title = cleanTitle(candidate.raw) || candidate.raw
    return { belongs: belongs, volume: split.volume, title: title, book: `${split.volume}|${seriesKey(title)}` }
}

/**
 * Volumes in reading order: by number, then upload order. A final part
 * ("Kanketsu-ban") is numbered one past the last volume.
 */
export const orderVolumes = <V extends { id: string | number; volume: number }>(volumes: V[]): V[] => {
    const ordered = volumes.slice().sort((a, b) => a.volume - b.volume || Number(a.id) - Number(b.id))
    let next = ordered.filter((volume) => volume.volume < FINAL)
        .reduce((highest, volume) => Math.max(highest, Math.floor(volume.volume)), 0) + 1
    for (const volume of ordered) {
        if (volume.volume >= FINAL) volume.volume = next++
    }
    return ordered
}

/**
 * Why a series has nothing to show, in words -- "No volumes found" read as a
 * fault. When the source saw its own volumes refused it can say so; otherwise
 * the site never returned them, and either rule may be why.
 */
export const nothingToShow = (base: string, refused: number, englishOnly: boolean): string => refused > 0
    ? `Every volume of "${base}" is left out by your settings (an excluded tag or a parody), so it will not be shown.`
    : englishOnly
        ? `No volumes of "${base}" can be shown: this source shows English galleries only, and leaves out anything your settings exclude.`
        : `No volumes of "${base}" can be shown: the site returned none, or your settings leave them all out.`
