import {
    Chapter,
    PartialSourceManga,
    SourceManga,
    Tag
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'

export const MC_DOMAIN = 'https://manhwaclub.net'

/**
 * Listings serve 10 per page and search serves 20, so no single page size can
 * decide when to stop. Paging therefore continues until a page comes back
 * genuinely empty; guessing a size once cut browsing off after page one.
 */

/** Covers are lazy-loaded, so the real URL can hide in a data attribute. */
const imageFrom = ($: CheerioAPI, element: any): string => {
    const img = $(element).find('img').first()
    const source = img.attr('data-src')
        ?? img.attr('data-lazy-src')
        ?? img.attr('srcset')?.split(' ')[0]
        ?? img.attr('src')
        ?? ''
    return source.trim()
}

export const parseTiles = ($: CheerioAPI): PartialSourceManga[] => {
    const tiles: PartialSourceManga[] = []
    const seen = new Set<string>()

    for (const element of $('div.page-item-detail, div.c-image-hover').toArray()) {
        const anchor = $(element).find('a[href*="/manga/"]').first()

        const slug = /\/manga\/([^/]+)\/?/.exec(anchor.attr('href') ?? '')?.[1]
        if (!slug || seen.has(slug)) continue

        const title = (anchor.attr('title') ?? anchor.text()).trim()
        if (title.length === 0) continue

        seen.add(slug)
        tiles.push(App.createPartialSourceManga({
            mangaId: slug,
            image: imageFrom($, element),
            title: title
        }))
    }

    return tiles
}

export const isLastPage = (tiles: PartialSourceManga[]): boolean => {
    return tiles.length === 0
}

/** Reads a value out of the `.post-content` label/value rows. */
const detailText = ($: CheerioAPI, label: string): string => {
    return $('div.post-content_item, div.post-status .post-content_item')
        .filter((_: number, row: any) => $(row).find('div.summary-heading').text().trim().toLowerCase().includes(label))
        .first()
        .find('div.summary-content')
        .text()
        .trim()
}

/**
 * The numeric post id drives the chapter AJAX call. It appears both as a body
 * class and as a data attribute, so either will do.
 */
export const parseMangaPostId = (html: string): string | undefined => {
    return /"manga_id"\s*:\s*"(\d+)"/.exec(html)?.[1]
        ?? /postid-(\d+)/.exec(html)?.[1]
        ?? /data-id="(\d+)"/.exec(html)?.[1]
}

const STATUS_MAP: Record<string, string> = {
    'completed': 'Completed',
    'complete': 'Completed',
    'ongoing': 'Ongoing',
    'on going': 'Ongoing',
    'canceled': 'Completed',
    'dropped': 'Completed'
}

export const parseMangaDetails = ($: CheerioAPI, mangaId: string): SourceManga => {
    // The heading carries an "18+" badge span that would otherwise end up
    // glued to the front of the title.
    const heading = $('div.post-title h1').first().length > 0
        ? $('div.post-title h1').first()
        : $('div.post-title h3').first()

    const title = heading.clone().find('span').remove().end().text().replace(/\s+/g, ' ').trim()

    const image = $('div.summary_image img').first().attr('data-src')
        ?? $('div.summary_image img').first().attr('src')
        ?? ''

    const description = $('div.description-summary div.summary__content').text().trim()
        || $('div.summary__content').first().text().trim()

    const author = detailText($, 'author')
    const artist = detailText($, 'artist')

    const rawStatus = detailText($, 'status').toLowerCase()
    const status = STATUS_MAP[rawStatus] ?? 'Ongoing'

    // Genre ids keep their slug so a filter selection round-trips to a URL.
    const tags: Tag[] = []
    const seen = new Set<string>()
    for (const element of $('a[href*="/manga-genre/"]').toArray()) {
        const slug = /\/manga-genre\/([^/]+)\/?/.exec($(element).attr('href') ?? '')?.[1]
        const label = $(element).text().trim()
        if (!slug || !label || seen.has(slug)) continue

        seen.add(slug)
        tags.push(App.createTag({ id: slug, label: label }))
    }

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: [title],
            image: image.trim(),
            author: author,
            artist: artist.length > 0 ? artist : author,
            desc: description,
            status: status,
            tags: tags.length > 0
                ? [App.createTagSection({ id: 'genres', label: 'Genres', tags: tags })]
                : []
        })
    })
}

/** Chapter numbers are embedded in the slug ("chapter-94-raw" -> 94). */
const chapterNumber = (href: string, name: string): number => {
    const fromName = /chapter\s*([\d.]+)/i.exec(name)?.[1]
    const fromHref = /chapter-([\d.]+)/i.exec(href)?.[1]
    const value = Number(fromName ?? fromHref)
    return isNaN(value) ? 0 : value
}

/**
 * Parses the chapter list. Madara serves this from admin-ajax rather than the
 * series page, but the markup is the same either way.
 */
export const parseChapters = ($: CheerioAPI, mangaId: string): Chapter[] => {
    const chapters: Chapter[] = []
    const seen = new Set<string>()

    for (const element of $('li.wp-manga-chapter, div.chapter-item').toArray()) {
        const anchor = $(element).find('a[href*="/manga/"]').first()
        const href = anchor.attr('href') ?? ''

        const slug = new RegExp(`/manga/${mangaId}/([^/]+)/?`).exec(href)?.[1]
        if (!slug || seen.has(slug)) continue

        const name = anchor.text().trim()
        seen.add(slug)

        // Series carry both translated and raw releases, and they share a
        // chapter number ("chapter-62" and "chapter-62-raw"). Tagging raws with
        // a different language keeps both readable instead of colliding.
        const isRaw = /-raw\/?$/.test(slug) || /\braw\b/i.test(name)

        // The site marks raws with a trailing lowercase "raw", which is easy to
        // miss in a long list, so it is normalised into a clear tag.
        const base = (name.length > 0 ? name : slug).replace(/\s*\braw\b\s*$/i, '').trim()
        const label = isRaw ? `${base} [RAW]` : base

        chapters.push(App.createChapter({
            id: slug,
            chapNum: chapterNumber(href, name),
            name: label,
            langCode: isRaw ? '🇰🇷' : '🇬🇧',
            // Paperback renders groups as the pills above the chapter list, so
            // this is what gives the reader Raw / Translated buttons to switch
            // between the two tracks instead of one interleaved list.
            group: isRaw ? 'Raw' : 'Translated',
            sortingIndex: chapters.length
        }))
    }

    // The site lists newest first; Paperback expects ascending order. Every
    // field has to be carried over here -- an earlier version rebuilt these
    // without `group`, which silently removed the Raw/Translated buttons.
    return chapters.reverse().map((chapter, index) => App.createChapter({
        id: chapter.id,
        chapNum: chapter.chapNum,
        name: chapter.name,
        langCode: chapter.langCode,
        group: chapter.group,
        sortingIndex: index
    }))
}

/**
 * Narrows a chapter list to one release track. Each track is published as its
 * own source, so a reader picks Raw or English rather than sifting one
 * interleaved list.
 *
 * A series that only publishes the other track still returns everything: an
 * empty chapter list would make the series look broken instead of untranslated.
 */
export const filterTrack = (chapters: Chapter[], group: 'Raw' | 'Translated'): Chapter[] => {
    const matching = chapters.filter((chapter) => chapter.group === group)
    return matching.length > 0 ? matching : chapters
}

export const parsePages = ($: CheerioAPI): string[] => {
    const pages: string[] = []

    for (const element of $('div.reading-content img').toArray()) {
        const image = $(element)
        const source = image.attr('data-src')
            ?? image.attr('data-lazy-src')
            ?? image.attr('src')
            ?? ''

        const trimmed = source.trim()
        if (trimmed.length > 0) pages.push(trimmed)
    }

    return pages
}

/** Genre slugs and names, for the search filter screen. */
export const parseGenres = ($: CheerioAPI): Tag[] => {
    const tags: Tag[] = []
    const seen = new Set<string>()

    for (const element of $('a[href*="/manga-genre/"]').toArray()) {
        const slug = /\/manga-genre\/([^/]+)\/?/.exec($(element).attr('href') ?? '')?.[1]
        const label = $(element).text().trim()
        if (!slug || !label || seen.has(slug)) continue

        seen.add(slug)
        tags.push(App.createTag({ id: slug, label: label }))
    }

    return tags
}
