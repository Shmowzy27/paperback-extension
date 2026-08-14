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

/** Gallery cards are identical across the listing, explore and search pages. */
export const parseTiles = ($: CheerioAPI): PartialSourceManga[] => {
    const tiles: PartialSourceManga[] = []

    for (const element of $('a[href^="/view/"]').toArray()) {
        const anchor = $(element)

        const id = /^\/view\/(\d+)$/.exec(anchor.attr('href') ?? '')?.[1]
        if (!id) continue

        const image = anchor.find('figure.image img').attr('src')
        if (!image) continue

        const title = anchor.find('.card-header-title').text().trim()
        if (!title) continue

        tiles.push(App.createPartialSourceManga({
            mangaId: id,
            image: image,
            title: title
        }))
    }

    return tiles
}

export const isLastPage = (tiles: PartialSourceManga[]): boolean => {
    return tiles.length < HN_PAGE_SIZE
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

export const parseMangaDetails = ($: CheerioAPI, mangaId: string): SourceManga => {
    const title = $('h1.title').first().text().trim()
    const image = $('figure.image img').first().attr('src') ?? ''
    const artist = detailText($, 'Artist')
    const description = detailText($, 'Description')

    const tags: Tag[] = []
    for (const element of $('table.view-page-details a[href*="/?q=tag:"]').toArray()) {
        const label = tagFromHref($(element).attr('href') ?? '')
        if (label) tags.push(App.createTag({ id: label, label: label }))
    }

    const additionalInfo: Record<string, string> = {}
    const pages = detailText($, 'Pages')
    const parody = detailText($, 'Parody')
    const publisher = detailText($, 'Publisher')
    if (pages) additionalInfo['Pages'] = pages
    if (parody) additionalInfo['Parody'] = parody
    if (publisher) additionalInfo['Publisher'] = publisher

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: [title],
            image: image,
            artist: artist,
            author: artist,
            desc: description,
            // A gallery is a finished book, never an ongoing serialisation.
            status: 'Completed',
            hentai: true,
            tags: tags.length > 0
                ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })]
                : [],
            additionalInfo: additionalInfo
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

/** A gallery is a single self-contained book, so it maps to exactly one chapter. */
export const parseChapters = ($: CheerioAPI, mangaId: string): Chapter[] => {
    return [
        App.createChapter({
            id: mangaId,
            chapNum: 1,
            name: 'Gallery',
            langCode: '🇬🇧',
            time: parsePublished(detailText($, 'Published'))
        })
    ]
}

/** Pulls the encrypted manifest out of the lone `initReader(...)` call. */
export const extractReaderPayload = (html: string): string => {
    const payload = /initReader\("([^"]+)"/.exec(html)?.[1]
    if (!payload) {
        throw new Error('Could not find the reader payload; the site layout may have changed.')
    }
    return payload
}
