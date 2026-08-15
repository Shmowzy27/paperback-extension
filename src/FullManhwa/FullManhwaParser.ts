import {
    Chapter,
    PartialSourceManga,
    SourceManga,
    Tag
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'

export const FM_DOMAIN = 'https://fullmanhwa.com'

/** Listings render 24 cards a page; a short page is the last one. */
export const FM_PAGE_SIZE = 24

/** The only taxonomy the site exposes. */
export const FM_TYPES: { id: string; label: string }[] = [
    { id: 'manhwa', label: 'Manhwa' },
    { id: 'manhua', label: 'Manhua' },
    { id: 'manga', label: 'Manga' }
]

/** Listings and search results share the same card markup. */
export const parseTiles = ($: CheerioAPI): PartialSourceManga[] => {
    const tiles: PartialSourceManga[] = []
    const seen = new Set<string>()

    for (const element of $('a.series-card').toArray()) {
        const anchor = $(element)

        const slug = /^\/manga\/([a-z0-9-]+)\/?$/.exec(anchor.attr('href') ?? '')?.[1]
        if (!slug || seen.has(slug)) continue

        const title = anchor.find('strong').first().text().trim()
        if (title.length === 0) continue

        seen.add(slug)
        tiles.push(App.createPartialSourceManga({
            mangaId: slug,
            image: (anchor.find('img').first().attr('src') ?? '').trim(),
            title: title
        }))
    }

    return tiles
}

export const isLastPage = (tiles: PartialSourceManga[]): boolean => {
    return tiles.length < FM_PAGE_SIZE
}

export const parseMangaDetails = ($: CheerioAPI, mangaId: string): SourceManga => {
    const title = $('h1').first().text().trim()
    const image = ($('.cover-card img').first().attr('src') ?? $('img').first().attr('src') ?? '').trim()

    const rawStatus = $('.status-badge').first().text().trim().toLowerCase()
    const status = rawStatus.includes('complet') ? 'Completed' : 'Ongoing'

    // The synopsis carries no stable class on the page, but the site puts it in
    // the meta description, which is the steadier source.
    const description = ($('meta[name="description"]').attr('content')
        ?? $('.series-synopsis, .synopsis, .description').first().text())
        .replace(/\s+/g, ' ')
        .trim()

    const tags: Tag[] = []
    const seen = new Set<string>()
    for (const element of $('a[href^="/type/"]').toArray()) {
        const slug = /^\/type\/([a-z0-9-]+)\/?$/.exec($(element).attr('href') ?? '')?.[1]
        const label = $(element).text().trim()
        if (!slug || !label || seen.has(slug)) continue

        seen.add(slug)
        tags.push(App.createTag({ id: slug, label: label }))
    }

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: [title],
            image: image,
            desc: description,
            status: status,
            tags: tags.length > 0
                ? [App.createTagSection({ id: 'type', label: 'Type', tags: tags })]
                : []
        })
    })
}

/**
 * Chapter rows carry their slug, number and title as data attributes, which is
 * steadier than reading them back out of the link text.
 */
export const parseChapters = ($: CheerioAPI): Chapter[] => {
    const rows: { slug: string; number: number; name: string }[] = []
    const seen = new Set<string>()

    for (const element of $('div.chapter-row').toArray()) {
        const row = $(element)

        const slug = (row.attr('data-chapter-slug') ?? '').trim()
            || /\/manga\/[^/]+\/([^/?"]+)/.exec(row.find('a.chapter-main').attr('href') ?? '')?.[1]
            || ''
        if (slug.length === 0 || seen.has(slug)) continue

        const number = Number(row.attr('data-number'))
        const name = row.find('.chapter-name strong').first().text().trim()
            || (row.attr('data-title') ?? '').trim()
            || slug

        seen.add(slug)
        rows.push({ slug, number: isNaN(number) ? 0 : number, name })
    }

    // The page lists newest first; Paperback expects ascending order.
    rows.sort((a, b) => a.number - b.number)

    return rows.map((row, index) => App.createChapter({
        id: row.slug,
        chapNum: row.number,
        name: row.name,
        langCode: '🇬🇧',
        sortingIndex: index
    }))
}

export interface ReaderHandle {
    endpoint: string
    token: string
    lang: string
}

/**
 * The reader element holds the endpoint and a token for the image API. The
 * token alone is not enough: the API also requires the session cookie that the
 * chapter page set, otherwise it answers `invalid_token`.
 */
export const parseReaderHandle = (html: string): ReaderHandle | undefined => {
    const box = /<[^>]*data-reader-image-box[^>]*>/.exec(html)?.[0]
    if (!box) return undefined

    const token = /data-token="([^"]+)"/.exec(box)?.[1]
    if (!token) return undefined

    return {
        endpoint: /data-endpoint="([^"]+)"/.exec(box)?.[1] ?? '/api/reader_images.php',
        token: token,
        lang: /data-lang="([^"]+)"/.exec(box)?.[1] ?? 'en'
    }
}

/**
 * Collects the cookies a response set, so they can be replayed on the API call.
 * Header casing and multi-value shape both vary, hence the defensive handling.
 */
export const cookiesFromHeaders = (headers: Record<string, unknown>): string => {
    const parts: string[] = []

    for (const key of Object.keys(headers ?? {})) {
        if (key.toLowerCase() !== 'set-cookie') continue

        const value = headers[key]
        const entries = Array.isArray(value) ? value : String(value).split(/,(?=[^;]+?=)/)

        for (const entry of entries) {
            const pair = String(entry).split(';')[0]?.trim()
            if (pair && pair.includes('=')) parts.push(pair)
        }
    }

    return parts.join('; ')
}

export const parseImagePayload = (body: string): string[] => {
    const payload = JSON.parse(body) as { ok?: boolean; images?: { url?: string }[]; error?: string }

    if (payload.ok !== true || !Array.isArray(payload.images)) {
        throw new Error(payload.error ?? 'The reader session was rejected.')
    }

    const pages: string[] = []
    for (const image of payload.images) {
        const url = (image.url ?? '').trim()
        if (url.length > 0) pages.push(url)
    }
    return pages
}
