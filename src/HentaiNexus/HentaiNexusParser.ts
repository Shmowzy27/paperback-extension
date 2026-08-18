import {
    Chapter,
    PartialSourceManga,
    SourceManga,
    Tag
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'

export const HN_DOMAIN = 'https://hentainexus.com'

/** The listing renders a fixed 30 cards per page, so a short page is the last one. */
export const HN_PAGE_SIZE = 30

/**
 * Series entries are addressed by their base title rather than a gallery id,
 * because no single gallery represents the whole series. Plain numeric ids are
 * still accepted so library entries saved before grouping existed keep working.
 */
export const SERIES_PREFIX = 's:'

export interface GalleryCard {
    id: string
    title: string
    thumbnailUrl: string
}

export interface SeriesVolume extends GalleryCard {
    volume: number
}

/** Raw cards, ungrouped. Pagination must be judged on these, not on series. */
export const parseCards = ($: CheerioAPI): GalleryCard[] => {
    const cards: GalleryCard[] = []

    for (const element of $('a[href^="/view/"]').toArray()) {
        const anchor = $(element)

        const id = /^\/view\/(\d+)$/.exec(anchor.attr('href') ?? '')?.[1]
        if (!id) continue

        const thumbnailUrl = anchor.find('figure.image img').attr('src')
        if (!thumbnailUrl) continue

        const title = anchor.find('.card-header-title').text().trim()
        if (!title) continue

        cards.push({ id, title, thumbnailUrl })
    }

    return cards
}

export const isLastPage = (cards: GalleryCard[]): boolean => {
    return cards.length < HN_PAGE_SIZE
}

/** Volume numbers are not always whole: "… 4.5" sits between 4 and 5. */
const VOLUME = '(\\d{1,3}(?:\\.\\d{1,2})?)'

/**
 * A volume is often followed by its own subtitle ("… 4: Sensuous Moans"), so
 * the number is not necessarily the end of the title. The separator is required
 * before a subtitle, which keeps "Title 2 Extra" from being read as volume 2.
 */
const SUBTITLE = '(?:\\s*[:\\-–—]\\s*.+)?'

/**
 * Ways a volume number is written, most specific first. The keyword forms have
 * to be tried before the bare number: "Title Ch. 5" also matches the bare form,
 * but yields the base "Title Ch.", which groups correctly and then displays a
 * mangled series name.
 *
 * The leading group is lazy so the *first* number wins. Greedy matching would
 * read "Title 2: Sub 3" as volume 3 of "Title 2: Sub".
 */
const VOLUME_PATTERNS: RegExp[] = [
    new RegExp(`^(.*?\\S)\\s+(?:ch\\.?|chapter)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s+(?:vol\\.?|volume)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s+(?:part|pt\\.?)\\s*${VOLUME}${SUBTITLE}$`, 'i'),
    new RegExp(`^(.*?\\S)\\s*#\\s*${VOLUME}${SUBTITLE}$`),
    new RegExp(`^(.*?\\S)\\s+${VOLUME}${SUBTITLE}$`)
]

/**
 * The site has no series field, so volumes are inferred from the title: a
 * trailing volume number is stripped and what precedes it is the series.
 * "Bedded by Your Best Friend 5" -> base "Bedded by Your Best Friend", volume 5.
 *
 * This necessarily mis-groups a standalone work whose title merely ends in a
 * number, and misses sequels numbered some other way entirely.
 */
export const splitTitle = (title: string): { base: string; volume: number } => {
    const trimmed = title.trim()

    for (const pattern of VOLUME_PATTERNS) {
        const match = pattern.exec(trimmed)
        if (!match) continue

        // Drop any separator left dangling once the number is removed.
        const base = (match[1] as string).replace(/[\s\-–—:,]+$/, '').trim()
        if (base.length > 0) return { base, volume: Number(match[2]) }
    }

    return { base: trimmed, volume: 1 }
}

export const seriesIdFor = (title: string): string => `${SERIES_PREFIX}${splitTitle(title).base}`

export const isSeriesId = (mangaId: string): boolean => mangaId.startsWith(SERIES_PREFIX)

export const baseFromSeriesId = (mangaId: string): string => mangaId.slice(SERIES_PREFIX.length)

/**
 * Collapses every volume on a page into a single entry per series.
 *
 * `seen` carries the series already emitted by earlier pages. Grouping only
 * ever sees one page at a time, so a series straddling a page boundary was
 * emitted again on the next page under the very same id -- volume 5 landing on
 * page 1 and volumes 1-4 on page 2 showed the series twice while scrolling an
 * artist's works. Whichever page it appears on first wins; opening it still
 * lists every volume, because the volumes are looked up by title rather than
 * taken from the page.
 */
export const groupIntoSeries = (cards: GalleryCard[], seen?: Set<string>): PartialSourceManga[] => {
    const series = new Map<string, { base: string; volume: number; card: GalleryCard }>()

    for (const card of cards) {
        const { base, volume } = splitTitle(card.title)
        const key = base.toLowerCase()
        const existing = series.get(key)

        // The lowest-numbered volume on the page supplies the cover.
        if (existing == undefined) {
            series.set(key, { base, volume, card })
        } else if (volume < existing.volume) {
            existing.volume = volume
            existing.card = card
        }
    }

    const results: PartialSourceManga[] = []
    for (const [key, entry] of series) {
        if (seen != undefined) {
            if (seen.has(key)) continue
            seen.add(key)
        }

        results.push(App.createPartialSourceManga({
            mangaId: `${SERIES_PREFIX}${entry.base}`,
            image: entry.card.thumbnailUrl,
            title: entry.base
        }))
    }
    return results
}

/** Keeps only the cards that really belong to `base`, ordered by volume. */
export const volumesOf = (cards: GalleryCard[], base: string): SeriesVolume[] => {
    const wanted = base.toLowerCase()
    const volumes: SeriesVolume[] = []

    for (const card of cards) {
        const split = splitTitle(card.title)
        if (split.base.toLowerCase() !== wanted) continue
        volumes.push({ ...card, volume: split.volume })
    }

    volumes.sort((a, b) => a.volume - b.volume)
    return volumes
}

/**
 * The site's own search syntax.
 *
 * The phrase is stripped to letters and numbers first. The search rejects a
 * quoted phrase that still carries punctuation and answers "No results found",
 * which reached the user as `No volumes found for "..."` on any title holding a
 * dash -- a subtitle wrapped in dashes is a common style here, so this hit a
 * lot of galleries. The site matches on normalised text itself, so the stripped
 * phrase still finds the gallery, and volumesOf re-checks the real title
 * afterwards, which keeps the grouping exact.
 *
 * Letters are matched by unicode property, so a non-Latin title is not gutted.
 */
export const seriesQuery = (base: string): string => {
    const phrase = base.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

    // A title made only of punctuation would leave nothing to search for.
    return `title:"${phrase.length > 0 ? phrase : base.replace(/"/g, '')}"`
}

/**
 * Filterable categories, each backed by /explore/categories/{prefix}. `author`
 * is omitted deliberately: the site lists exactly one entry under it.
 */
export const CATEGORIES: { prefix: string; label: string }[] = [
    { prefix: 'tag', label: 'Tags' },
    { prefix: 'artist', label: 'Artists' },
    { prefix: 'circle', label: 'Circles' },
    { prefix: 'parody', label: 'Parodies' },
    { prefix: 'magazine', label: 'Magazines' },
    { prefix: 'publisher', label: 'Publishers' },
    { prefix: 'event', label: 'Events' }
]

/**
 * Category values come from the href rather than the link text, which carries a
 * usage count ("vanilla (8,359)"). Ids keep their prefix so a search can tell
 * an artist from a tag.
 */
export const parseCategoryTags = ($: CheerioAPI, prefix: string): Tag[] => {
    const pattern = new RegExp(`/\\?q=${prefix}:(.+)$`)
    const seen = new Set<string>()
    const tags: Tag[] = []

    for (const element of $(`a[href*="/?q=${prefix}:"]`).toArray()) {
        const raw = pattern.exec($(element).attr('href') ?? '')?.[1]
        if (!raw) continue

        const value = decodeURIComponent(raw.replace(/\+/g, ' ')).trim().replace(/^"|"$/g, '').trim()
        if (value.length === 0 || seen.has(value)) continue

        seen.add(value)
        tags.push(App.createTag({ id: `${prefix}:${value}`, label: value }))
    }

    return tags
}

/**
 * Turns a tag id into one search term. Values containing spaces have to be
 * quoted, and a leading minus is how the site excludes a term.
 */
export const toSearchTerm = (tagId: string, exclude: boolean): string => {
    const separator = tagId.indexOf(':')
    // Ids without a prefix predate category filtering; they were plain tags.
    const prefix = separator < 0 ? 'tag' : tagId.slice(0, separator)
    const value = separator < 0 ? tagId : tagId.slice(separator + 1)

    const quoted = /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value
    return `${exclude ? '-' : ''}${prefix}:${quoted}`
}

/**
 * Every linked value carries a nested `.small-tag-count` badge ("Homunculus (68)"),
 * which has to come off before the text is usable as a name.
 */
const cleanText = ($: CheerioAPI, element: any): string => {
    return $(element).clone().find('.small-tag-count').remove().end().text().trim()
}

const detailText = ($: CheerioAPI, label: string): string => {
    const row = $('table.view-page-details tr')
        .filter((_: number, element: any) => $(element).find('td.viewcolumn').text().trim() === label)
        .first()
        .find('td')
        .not('.viewcolumn')
        .first()

    return cleanText($, row)
}

/**
 * Tag links render their name with a usage count baked into the text
 * ("blowjob (8,359)"), so the href is the only clean source. It also happens to
 * be the exact term the site's own search expects back.
 */
const tagFromHref = (href: string): string | undefined => {
    const raw = /\/\?q=tag:(.+)$/.exec(href)?.[1]
    if (!raw) return undefined

    const decoded = decodeURIComponent(raw.replace(/\+/g, ' ')).trim()
    const unquoted = decoded.replace(/^"|"$/g, '').trim()
    return unquoted.length > 0 ? unquoted : undefined
}

/**
 * Builds details from one gallery page. For a merged series the page belongs to
 * the first volume, and `overrideTitle` carries the series name instead.
 */
export const parseMangaDetails = (
    $: CheerioAPI,
    mangaId: string,
    overrideTitle?: string,
    volumeCount?: number
): SourceManga => {
    const galleryTitle = $('h1.title').first().text().trim()
    const title = overrideTitle ?? galleryTitle
    const image = $('figure.image img').first().attr('src') ?? ''
    const artist = detailText($, 'Artist')
    const description = detailText($, 'Description')

    // Ids carry the `tag:` prefix so tapping one on the details screen searches
    // the same way the category filters do.
    const tags: Tag[] = []
    for (const element of $('table.view-page-details a[href*="/?q=tag:"]').toArray()) {
        const label = tagFromHref($(element).attr('href') ?? '')
        if (label) tags.push(App.createTag({ id: `tag:${label}`, label: label }))
    }

    // Surfaced in the description because `additionalInfo` is not part of the
    // MangaInfo interface, and passing it kept entries out of the Library.
    const facts: string[] = []
    if (volumeCount != undefined && volumeCount > 1) facts.push(`Volumes: ${volumeCount}`)
    const pages = detailText($, 'Pages')
    const parody = detailText($, 'Parody')
    const publisher = detailText($, 'Publisher')
    if (pages) facts.push(`Pages: ${pages}${volumeCount != undefined && volumeCount > 1 ? ' (first volume)' : ''}`)
    if (parody) facts.push(`Parody: ${parody}`)
    if (publisher) facts.push(`Publisher: ${publisher}`)

    const synopsis = facts.length > 0
        ? `${facts.join(' | ')}\n\n${description}`.trim()
        : description

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: [title],
            image: image,
            artist: artist,
            author: artist,
            desc: synopsis,
            // A gallery is a finished book, never an ongoing serialisation.
            status: 'Completed',
            // `hentai` is deliberately not set. The app uses that per-title flag
            // to hide entries from the Library, which made added titles vanish.
            // Adult visibility is already handled by the source's ContentRating.
            tags: tags.length > 0
                ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })]
                : []
        })
    })
}

const MONTHS = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
]

/**
 * Dates render as "18 September 2015". Parsed by hand rather than handed to
 * `new Date(...)`, because that format is not part of the spec and Paperback
 * runs JavaScriptCore, which need not agree with V8 on non-standard input.
 * Not every gallery has a Published row, so absence is expected.
 */
const parsePublished = (value: string): Date | undefined => {
    const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(value.trim())
    if (!match) return undefined

    const month = MONTHS.indexOf((match[2] as string).toLowerCase())
    if (month < 0) return undefined

    const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])))
    return isNaN(date.getTime()) ? undefined : date
}

/** A standalone gallery is one self-contained book, so it maps to one chapter. */
export const parseChapters = ($: CheerioAPI, mangaId: string): Chapter[] => {
    return [
        App.createChapter({
            id: mangaId,
            chapNum: 1,
            name: 'Gallery',
            langCode: '🇬🇧',
            sortingIndex: 1,
            time: parsePublished(detailText($, 'Published'))
        })
    ]
}

/** The publication date of a single gallery page. */
export const parseGalleryDate = ($: CheerioAPI): Date | undefined => {
    return parsePublished(detailText($, 'Published'))
}

/**
 * Each volume of a merged series becomes its own chapter, in volume order.
 * `sortingIndex` is the position rather than the volume, since volumes can be
 * fractional ("4.5") while the index is expected to be a plain counter.
 *
 * Dates are supplied by the caller, keyed on gallery id: they live on each
 * volume's own page, so they cost a request apiece to collect.
 */
export const chaptersFromVolumes = (
    volumes: SeriesVolume[],
    times?: Record<string, Date | undefined>
): Chapter[] => {
    return volumes.map((entry, index) => App.createChapter({
        id: entry.id,
        chapNum: entry.volume,
        name: entry.title,
        time: times?.[entry.id],
        langCode: '🇬🇧',
        sortingIndex: index
    }))
}

/** Pulls the encrypted manifest out of the lone `initReader(...)` call. */
export const extractReaderPayload = (html: string): string => {
    const payload = /initReader\("([^"]+)"/.exec(html)?.[1]
    if (!payload) {
        throw new Error('Could not find the reader payload; the site layout may have changed.')
    }
    return payload
}
