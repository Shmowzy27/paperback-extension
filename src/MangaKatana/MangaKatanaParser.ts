import {
    Chapter,
    SourceManga,
    Tag
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'

/**
 * mangakatana.com. The user reads it through livezy.click/mangafire, but that
 * page is nothing except ad scripts around an iframe of this site, so the
 * source goes straight to the origin.
 */
export const MK_DOMAIN = 'https://mangakatana.com'

/** Listings render 20 cards a page; a short page is the last one. */
export const MK_PAGE_SIZE = 20

/**
 * This source is deliberately 18+ only: a title is admitted when it carries at
 * least one of these genres, whatever its format -- manga, manhwa, manhua or
 * webtoon alike.
 *
 * The numeric ids mirror the site's own filter form and matter because listing
 * cards annotate their genres as ids (`data-genre=",19,23,..."`), which is what
 * lets every surface re-check the rule client-side.
 */
export const MK_WANTED: { id: number; slug: string; label: string }[] = [
    { id: 18, slug: 'adult', label: 'Adult' },
    { id: 23, slug: 'ecchi', label: 'Ecchi' },
    { id: 34, slug: 'erotica', label: 'Erotica' },
    { id: 31, slug: 'sexual-violence', label: 'Sexual violence' }
]

/**
 * Never shown, even when a title also carries a wanted genre: gender bender is
 * out by request, and yaoi plus shounen-ai covers the site's BL labels.
 */
export const MK_BANNED: { id: number; slug: string; label: string }[] = [
    { id: 33, slug: 'gender-bender', label: 'Gender Bender' },
    { id: 40, slug: 'yaoi', label: 'Yaoi' },
    { id: 29, slug: 'shounen-ai', label: 'Shounen ai' }
]

const WANTED_IDS = new Set(MK_WANTED.map((genre) => genre.id))
const BANNED_IDS = new Set(MK_BANNED.map((genre) => genre.id))
const BANNED_SLUGS = new Set(MK_BANNED.map((genre) => genre.slug))

/**
 * The site's own advanced filter, pre-set to the 18+ rule. `include` and
 * `exclude` take underscore-joined genre slugs -- the site's filter script
 * joins the checkbox values that way -- and OR mode admits any wanted genre
 * rather than demanding all four at once.
 */
export const filteredListingUrl = (order: string, page: number, includeSlugs?: string[]): string => {
    const include = (includeSlugs != undefined && includeSlugs.length > 0
        ? includeSlugs
        : MK_WANTED.map((genre) => genre.slug)).join('_')
    const exclude = MK_BANNED.map((genre) => genre.slug).join('_')

    const path = page <= 1 ? '/manga/' : `/manga/page/${page}`
    return `${MK_DOMAIN}${path}?filter=1&include=${include}&exclude=${exclude}&include_mode=or&bookmark_opts=off&chapters=1&order=${order}`
}

/** Text search; paged as /page/{n} with the query carried along. */
export const searchUrl = (query: string, page: number): string => {
    const path = page <= 1 ? '/' : `/page/${page}`
    return `${MK_DOMAIN}${path}?search=${encodeURIComponent(query)}&search_by=book_name`
}

export interface TileRow {
    mangaId: string
    title: string
    image: string
}

/**
 * The `slug.id` path segment that identifies a series, e.g.
 * `disaster-fox-kuzure-chan.26563`.
 */
const mangaIdFrom = (href: string): string | undefined => {
    return /\/manga\/([^/?#]+\.\d+)\/?$/.exec(href)?.[1]
}

/**
 * Cards carry their genres as `data-genre=",19,23,52,"`. The 18+ rule is
 * enforced here on every card, not only trusted to the server's filter: search
 * has no genre filter at all, and belt-and-braces on the filtered listings
 * costs nothing.
 */
const cardAdmitted = (dataGenre: string): boolean => {
    const ids: number[] = []
    for (const part of dataGenre.split(',')) {
        const id = Number(part.trim())
        if (!isNaN(id) && part.trim().length > 0) ids.push(id)
    }

    return ids.some((id) => WANTED_IDS.has(id)) && !ids.some((id) => BANNED_IDS.has(id))
}

/** Listing and search results share the same `#book_list .item` cards. */
export const parseTiles = ($: CheerioAPI): TileRow[] => {
    const rows: TileRow[] = []
    const seen = new Set<string>()

    for (const element of $('#book_list div.item[data-genre]').toArray()) {
        const card = $(element)
        if (!cardAdmitted(card.attr('data-genre') ?? '')) continue

        const anchor = card.find('h3.title a').first()
        const mangaId = mangaIdFrom(anchor.attr('href') ?? '')
        const title = anchor.text().trim()
        if (mangaId == undefined || title.length === 0 || seen.has(mangaId)) continue

        // The plain <img> is the jpg fallback; its webp sibling needs <picture>
        // support that is not worth assuming.
        const image = (card.find('.wrap_img img').first().attr('src') ?? '').trim()

        seen.add(mangaId)
        rows.push({ mangaId: mangaId, title: title, image: image })
    }

    return rows
}

/**
 * Raw card count, before the 18+ rule drops any. Pagination has to be judged
 * on this: a page can be full while every card on it is filtered out.
 */
export const countCards = ($: CheerioAPI): number => {
    return $('#book_list div.item[data-genre]').length
}

export const isLastPage = ($: CheerioAPI): boolean => {
    return countCards($) < MK_PAGE_SIZE
}

export const parseMangaDetails = ($: CheerioAPI, mangaId: string): SourceManga => {
    const title = $('h1.heading').first().text().trim() || $('h1').first().text().trim() || mangaId

    const titles = [title]
    // "災い狐のくずれちゃん ; Wazawai kitsune no Kuzure-chan"
    for (const alt of $('.alt_name').first().text().split(';')) {
        const name = alt.trim()
        if (name.length > 0 && !titles.includes(name)) titles.push(name)
    }

    const image = ($('.cover img').first().attr('src') ?? '').trim()

    const rawStatus = $('.value.status').first().text().trim().toLowerCase()
    const status = rawStatus.includes('complet') ? 'Completed' : 'Ongoing'

    const author = $('.authors a.author').toArray()
        .map((element) => $(element).text().trim())
        .filter((name) => name.length > 0)
        .join(', ')

    const description = $('.summary p').text().trim() || $('.summary').text().replace(/^\s*Description\s*/i, '').trim()

    // Scoped to the meta list: a bare `.genres a` also sweeps the sidebar's
    // genre index, which lists every genre the site has and made each title
    // appear to carry all fifty-two of them.
    const tags: Tag[] = []
    const seen = new Set<string>()
    for (const element of $('ul.meta .genres a[href*="/genre/"], .info .genres a[href*="/genre/"]').toArray()) {
        const slug = /\/genre\/([a-z0-9-]+)\/?$/.exec($(element).attr('href') ?? '')?.[1]
        const label = $(element).text().trim()
        if (slug == undefined || label.length === 0 || seen.has(slug)) continue

        seen.add(slug)
        tags.push(App.createTag({ id: slug, label: label }))
    }

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: titles,
            image: image,
            desc: description,
            status: status,
            author: author,
            tags: tags.length > 0
                ? [App.createTagSection({ id: 'genre', label: 'Genres', tags: tags })]
                : []
        })
    })
}

/**
 * A series page carries its genres as links, which is how a directly-opened
 * series -- via search of an old bookmark, say -- is checked against the rule
 * when its listing card is not around to ask.
 */
export const detailsAdmitted = ($: CheerioAPI): boolean => {
    const slugs = new Set<string>()
    for (const element of $('ul.meta .genres a[href*="/genre/"], .info .genres a[href*="/genre/"]').toArray()) {
        const slug = /\/genre\/([a-z0-9-]+)\/?$/.exec($(element).attr('href') ?? '')?.[1]
        if (slug != undefined) slugs.add(slug)
    }

    return MK_WANTED.some((genre) => slugs.has(genre.slug))
        && ![...slugs].some((slug) => BANNED_SLUGS.has(slug))
}

const MONTHS = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
]

/**
 * Dates render as "Aug-19-2026". Parsed by hand and assembled through Date.UTC
 * rather than `new Date(string)`: Paperback runs JavaScriptCore and this repo
 * has already lost a chapter time once to an engine disagreement over
 * non-standard date input.
 */
export const parseChapterDate = (raw: string): Date | undefined => {
    const match = /^([A-Za-z]{3})-(\d{1,2})-(\d{4})$/.exec(raw.trim())
    if (!match) return undefined

    const month = MONTHS.indexOf((match[1] as string).toLowerCase())
    if (month < 0) return undefined

    const date = new Date(Date.UTC(Number(match[3]), month, Number(match[2])))
    return isNaN(date.getTime()) ? undefined : date
}

/**
 * Chapters are table rows: a `.chapter a` link ending `/c{number}` and an
 * `.update_time` cell. "54.5" style fractions appear, hence the decimal.
 */
export const parseChapters = ($: CheerioAPI): Chapter[] => {
    const rows: { slug: string; number: number; name: string; time?: Date }[] = []
    const seen = new Set<string>()

    for (const element of $('.chapters tr').toArray()) {
        const row = $(element)

        const href = row.find('.chapter a').first().attr('href') ?? ''
        const slug = /\/(c[\d.]+)\/?$/.exec(href)?.[1]
        if (slug == undefined || seen.has(slug)) continue

        const number = Number(slug.slice(1))

        seen.add(slug)
        rows.push({
            slug: slug,
            number: isNaN(number) ? 0 : number,
            name: row.find('.chapter a').first().text().trim() || slug,
            time: parseChapterDate(row.find('.update_time').first().text())
        })
    }

    // The table lists newest first; Paperback expects ascending order.
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
 * The reader ships its pages as a JS array of tokenised CDN URLs, under a
 * variable whose name rotates with the obfuscation (`thzq` today, something
 * else tomorrow). So no name is trusted: every array literal of https URLs in
 * the page is collected and the longest wins -- the decoys seen so far hold a
 * single URL, while the real list holds one per page.
 */
export const parsePages = (html: string): string[] => {
    let best: string[] = []

    for (const match of html.matchAll(/=\s*\[([^\]]+)\]/g)) {
        const urls = [...(match[1] as string).matchAll(/['"](https?:\/\/[^'"]+)['"]/g)]
            .map((entry) => (entry[1] as string).replace(/^http:\/\//, 'https://'))
            .filter((url) => !url.endsWith('.js') && !url.endsWith('.css'))

        if (urls.length > best.length) best = urls
    }

    return best
}
