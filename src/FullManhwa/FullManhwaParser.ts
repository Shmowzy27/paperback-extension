import {
    Chapter,
    SourceManga,
    Tag
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'

/**
 * fullmanhwa.com moved to saymanhwa.com, which is a rebuild rather than a
 * rename: the routes, the card markup and the reader all changed.
 *
 * Every page sits behind an `/en` locale prefix and a bare path 302s to it, so
 * requests are built against SM_BASE and never the bare domain.
 */
export const SM_DOMAIN = 'https://saymanhwa.com'
export const SM_BASE = `${SM_DOMAIN}/en`

/** Listings render 24 cards a page; a short page is the last one. */
export const SM_PAGE_SIZE = 24

/**
 * Curated listings. These paths survived the rebuild. `/uncensored` is still
 * where the adult titles live -- they do not appear under the origin listings.
 */
export const SM_SECTIONS: { id: string; label: string; path: string }[] = [
    { id: 'latest', label: 'Latest Releases', path: '/latest' },
    { id: 'uncensored', label: 'Uncensored (18+)', path: '/uncensored' },
    { id: 'popular', label: 'Popular', path: '/popular' },
    { id: 'completed', label: 'Completed', path: '/completed' }
]

/**
 * `/type/{kind}` is gone -- it 404s. The rebuild serves the same split straight
 * off the locale root instead, as `/en/manhwa`.
 */
export const SM_ORIGINS: { id: string; label: string }[] = [
    { id: 'manhwa', label: 'Manhwa' },
    { id: 'manhua', label: 'Manhua' },
    { id: 'manga', label: 'Manga' },
    { id: 'adult', label: 'Adult' }
]

/** Genre ids are namespaced so routeFor can tell them from sections/origins. */
export const SM_GENRE_PREFIX = 'genre:'

/** Where the site writes a field it has no value for. */
const PLACEHOLDER = /^(updating|unknown|none|n\/a|-)$/i

/** Maps a section, origin or genre id onto the path that lists it. */
export const routeFor = (id: string): string => {
    if (id.startsWith(SM_GENRE_PREFIX)) {
        return `/genres/${id.slice(SM_GENRE_PREFIX.length)}`
    }

    const section = SM_SECTIONS.find((entry) => entry.id === id)
    if (section != undefined) return section.path

    const origin = SM_ORIGINS.find((entry) => entry.id === id)
    return origin != undefined ? `/${origin.id}` : '/latest'
}

/**
 * Image URLs must end up https: ManhwaClub served http:// once, which 301s and
 * renders as a blank page on iOS. Page images come from rotating third-party
 * CDNs (imgsrv5.com, img01.manhwabuddy.com, ...), so the host is never assumed
 * -- only the scheme is normalised and relative paths are resolved.
 */
export const absoluteUrl = (raw: string | undefined): string => {
    const value = (raw ?? '').trim()
    if (value.length === 0) return ''

    if (value.startsWith('//')) return `https:${value}`
    if (value.startsWith('/')) return `${SM_DOMAIN}${value}`
    if (value.startsWith('http://')) return `https://${value.slice(7)}`
    return value
}

export interface TileRow {
    slug: string
    title: string
    image: string
}

/**
 * Listings and search results share the same card markup.
 *
 * The card is `article.series-card`, not the old `a.series-card`, and the title
 * is in the card body heading -- a `<strong>` inside a card is now the latest
 * chapter number, so reading it as the title yields "Chapter 34". Parsing is
 * scoped to the catalog grid when present so the recommendation rails that
 * appear on other pages cannot leak in and repeat across pages.
 *
 * Plain rows are returned rather than PartialSourceManga: the local harnesses
 * stub the App factories as identity functions, so a field read back off a
 * created object round-trips off-device and silently fails on the phone.
 */
export const parseTiles = ($: CheerioAPI): TileRow[] => {
    const rows: TileRow[] = []
    const seen = new Set<string>()

    const grid = $('section.series-catalog-grid article.series-card').toArray()
    const elements = grid.length > 0 ? grid : $('article.series-card').toArray()

    for (const element of elements) {
        const card = $(element)

        const href = card.find('a[href*="/series/"]').first().attr('href') ?? ''
        const slug = /\/series\/([^/?#]+)\/?$/.exec(href)?.[1]
        if (slug == undefined || seen.has(slug)) continue

        const title = card.find('.series-card-body h2').first().text().trim()
        if (title.length === 0) continue

        seen.add(slug)
        rows.push({
            slug: slug,
            title: title,
            image: absoluteUrl(card.find('img').first().attr('src'))
        })
    }

    return rows
}

export const isLastPage = (rows: TileRow[]): boolean => {
    return rows.length < SM_PAGE_SIZE
}

/**
 * The catalog filter's own `<select name="genre">` is the site's genre list,
 * already slug-and-label paired. The `/en/genres` index carries the same names
 * but with a published count glued onto each link's text, so the select is the
 * cleaner source. Its leading "All genres" option has an empty value and drops
 * out on its own.
 */
export const parseGenres = ($: CheerioAPI): { id: string; label: string }[] => {
    const genres: { id: string; label: string }[] = []
    const seen = new Set<string>()

    for (const element of $('select[name="genre"] option').toArray()) {
        const option = $(element)

        const slug = (option.attr('value') ?? '').trim()
        const label = option.text().trim()
        if (slug.length === 0 || label.length === 0 || seen.has(slug)) continue

        seen.add(slug)
        genres.push({ id: `${SM_GENRE_PREFIX}${slug}`, label: label })
    }

    return genres
}

const asText = (value: unknown): string => {
    return typeof value === 'string' ? value.trim() : ''
}

/**
 * The rebuild embeds a CreativeWorkSeries block holding the synopsis, cover,
 * genres and author already decoded. That is steadier than scraping the
 * sidebar, whose class names are version-stamped (`series-v72-*`) and so churn
 * with every theme bump.
 */
const seriesLd = ($: CheerioAPI): Record<string, unknown> | undefined => {
    for (const element of $('script[type="application/ld+json"]').toArray()) {
        const raw = $(element).text().trim()
        if (raw.length === 0 || !raw.includes('CreativeWorkSeries')) continue

        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>
            if (parsed['@type'] === 'CreativeWorkSeries') return parsed
        } catch {
            // A malformed block is skipped rather than failing the whole page.
        }
    }

    return undefined
}

/** Reads one labelled row out of the sidebar meta panel, e.g. Status/Author. */
const metaValue = ($: CheerioAPI, label: string): string => {
    for (const element of $('.series-v72-meta div').toArray()) {
        const row = $(element)
        if (row.find('span').first().text().trim().toLowerCase() !== label) continue
        return row.find('strong').first().text().trim()
    }
    return ''
}

const namesFrom = (value: unknown): string[] => {
    const names: string[] = []

    const entries = Array.isArray(value) ? value : [value]
    for (const entry of entries) {
        const name = typeof entry === 'object' && entry != null
            ? asText((entry as Record<string, unknown>)['name'])
            : asText(entry)
        if (name.length === 0 || PLACEHOLDER.test(name) || names.includes(name)) continue
        names.push(name)
    }

    return names
}

export const parseMangaDetails = ($: CheerioAPI, mangaId: string): SourceManga => {
    const ld = seriesLd($)

    const title = asText(ld?.['name'])
        || $('.series-v72-summary h1').first().text().trim()
        || $('h1').first().text().trim()
        || mangaId

    const image = absoluteUrl(asText(ld?.['image']) || $('.series-v72-cover img').first().attr('src'))

    const description = (asText(ld?.['description']) || $('meta[name="description"]').attr('content') || '')
        .replace(/\s+/g, ' ')
        .trim()

    const rawStatus = (metaValue($, 'status') || $('.series-status-badge').first().text()).toLowerCase()
    const status = rawStatus.includes('complet') ? 'Completed' : 'Ongoing'

    // Alternative titles are one comma-joined string, padded with the site's
    // "Updating" placeholder. Carrying the real ones helps the app match a
    // series the user already has under another name.
    const titles = [title]
    for (const alt of asText(ld?.['alternateName']).split(',')) {
        const name = alt.trim()
        if (name.length === 0 || PLACEHOLDER.test(name) || titles.includes(name)) continue
        titles.push(name)
    }

    // Genres are optional -- plenty of adult titles carry none at all, and are
    // filed only under an origin type. Links are read first because they hand
    // over the real slug; the JSON-LD names are a fallback for when the sidebar
    // markup churns, and their slug has to be reconstructed.
    const tags: Tag[] = []
    const seen = new Set<string>()

    for (const element of $('.series-v72-genres a, a[href*="/genres/"]').toArray()) {
        const slug = /\/genres\/([^/?#]+)\/?$/.exec($(element).attr('href') ?? '')?.[1]
        const label = $(element).text().trim()
        if (slug == undefined || label.length === 0 || seen.has(slug)) continue

        seen.add(slug)
        tags.push(App.createTag({ id: `${SM_GENRE_PREFIX}${slug}`, label: label }))
    }

    if (tags.length === 0) {
        for (const label of namesFrom(ld?.['genre'])) {
            const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
            if (slug.length === 0 || seen.has(slug)) continue

            seen.add(slug)
            tags.push(App.createTag({ id: `${SM_GENRE_PREFIX}${slug}`, label: label }))
        }
    }

    const authors = namesFrom(ld?.['author'])
    const author = authors.length > 0 ? authors.join(', ') : namesFrom(metaValue($, 'author')).join(', ')

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: titles,
            image: image,
            desc: description,
            status: status,
            author: author,
            tags: tags.length > 0
                ? [App.createTagSection({ id: 'genre', label: 'Genre', tags: tags })]
                : []
        })
    })
}

/**
 * Dates now arrive as ISO 8601 with an offset, e.g. `2026-08-17T22:03:42+07:00`
 * -- the old "Aug 14, 2026" and relative-age strings are gone.
 *
 * Parsed by hand and assembled through Date.UTC rather than handed to
 * `new Date(string)`, because Paperback runs JavaScriptCore and this repo has
 * already lost a chapter `time` once to an engine disagreement over date input.
 */
export const parseChapterDate = (raw: string | undefined): Date | undefined => {
    const value = (raw ?? '').trim()
    if (value.length === 0) return undefined

    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(value)
    if (!match) return undefined

    const num = (part: string | undefined): number => (part == undefined ? 0 : Number(part))

    let stamp = Date.UTC(
        num(match[1]),
        num(match[2]) - 1,
        num(match[3]),
        num(match[4]),
        num(match[5]),
        num(match[6])
    )
    if (isNaN(stamp)) return undefined

    // An offset means the wall clock was local to the site, so it is undone to
    // land on the real instant.
    const zone = match[7]
    if (zone != undefined && zone !== 'Z') {
        const digits = zone.slice(1).replace(':', '')
        const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))
        if (isNaN(minutes)) return undefined
        stamp -= (zone.startsWith('-') ? -1 : 1) * minutes * 60000
    }

    return new Date(stamp)
}

/**
 * Chapter rows are anchors carrying `data-chapter-item` and
 * `data-chapter-number`; the old `.chapter-row` markup is gone.
 *
 * Every chapter ships in the HTML even though only the first 40 are visible --
 * the "show more" button just unhides rows that are already in the document --
 * so the list needs no second request.
 */
export const parseChapters = ($: CheerioAPI): Chapter[] => {
    const rows: { slug: string; number: number; name: string; time?: Date }[] = []
    const seen = new Set<string>()

    for (const element of $('a[data-chapter-item]').toArray()) {
        const row = $(element)

        const slug = /\/series\/[^/]+\/([^/?#]+)\/?$/.exec(row.attr('href') ?? '')?.[1]
        if (slug == undefined || seen.has(slug)) continue

        const number = Number(row.attr('data-chapter-number'))

        seen.add(slug)
        rows.push({
            slug: slug,
            number: isNaN(number) ? 0 : number,
            name: row.find('strong').first().text().trim() || slug,
            time: parseChapterDate(row.find('time').first().attr('datetime'))
        })
    }

    // The page lists newest first; Paperback expects ascending order.
    rows.sort((a, b) => a.number - b.number)

    return rows.map((row, index) => App.createChapter({
        id: row.slug,
        chapNum: row.number,
        name: row.name,
        time: row.time,
        langCode: '🇬🇧',
        sortingIndex: index
    }))
}

/**
 * The old reader mechanism is gone entirely: no `data-reader-image-box`, no
 * `data-token`, no `/api/reader_images.php`. The rebuilt reader ships the page
 * images as plain `<img>` inside `.reader-pages`, so they are read straight out
 * of the chapter HTML with no token or session handshake.
 *
 * Scoping to `.reader-pages` is what keeps the theme's flag and logo images out.
 */
export const parsePages = ($: CheerioAPI): string[] => {
    const pages: string[] = []
    const seen = new Set<string>()

    for (const element of $('.reader-pages img').toArray()) {
        const img = $(element)

        // `src` can hold a placeholder when a page is lazily attached, so the
        // data- attributes win where the theme uses them.
        const url = absoluteUrl(img.attr('data-src') || img.attr('data-original') || img.attr('src'))
        if (url.length === 0 || seen.has(url)) continue

        seen.add(url)
        pages.push(url)
    }

    return pages
}
