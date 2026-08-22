/*
 * Runs the built AsmHentai bundle against the live site.
 *
 * This source exists for two reasons -- it is fast, and it is filtered -- so
 * both are audited with real data: no Chinese or Japanese-only gallery may
 * survive, no banned tag may reach the reader, and known-excluded galleries
 * must refuse to open. Ground truth is read off the site's own listings rather
 * than hardcoded, so the checks track the site.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const GAP_MS = Number(process.env.ASM_GAP_MS ?? 600)

const identity = (x) => x
let requests = 0

global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ ...i }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request, retry) => {
            let lastError
            for (let attempt = 0; attempt <= (retry ?? 1); attempt++) {
                const gap = Math.max(1000 / (opts.requestsPerSecond || 3), GAP_MS)
                const wait = Math.max(0, (global.__last || 0) + gap - Date.now())
                if (wait > 0) await new Promise((r) => setTimeout(r, wait))
                global.__last = Date.now()
                try {
                    requests++
                    const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
                    const res = await fetch(req.url, {
                        method: req.method || 'GET',
                        headers: { accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(req.headers || {}) },
                        redirect: 'follow',
                        signal: AbortSignal.timeout(opts.requestTimeout || 30000)
                    })
                    const body = await res.text()
                    if (res.ok && body.length === 0) throw new Error('empty response body')
                    return { data: body, status: res.status, headers: {}, request: req }
                } catch (error) { lastError = error }
            }
            throw lastError
        }
    })
}

const path = require('node:path')
const { Sources } = require(path.join(__dirname, '..', 'bundles', 'AsmHentai', 'source.js'))

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}
const note = (label, detail) => console.log(`note  ${label}${detail ? ` — ${detail}` : ''}`)

const raw = async (url) => (await fetch(url, { headers: { 'user-agent': UA } })).text()

const expectGateThrow = async (label, fn) => {
    try {
        await fn()
        check(label, false, 'opened instead of refusing')
    } catch (error) {
        check(label, /will not be shown/i.test(error.message), error.message.slice(0, 80))
    }
}

;(async () => {
    const s = new Sources.AsmHentai()

    // ---- home sections ----
    const sections = []
    await s.getHomePageSections((sec) => sections.push(sec))
    check('home sections all carry items',
        sections.length === 2 && sections.every((x) => Array.isArray(x.items) && x.items.length > 0),
        sections.map((x) => `${x.title}:${x.items?.length}`).join(', '))
    check('tiles carry an id, https cover and a title',
        sections[0].items.every((t) => (/^\d+$/.test(t.mangaId) || t.mangaId.startsWith('s:'))
            && t.image.startsWith('https://') && t.title.length > 0),
        JSON.stringify(sections[0].items[0]).slice(0, 110))

    // ---- pagination ----
    let meta
    const ids = []
    for (let i = 0; i < 3; i++) {
        const res = await s.getViewMoreItems('latest', meta)
        for (const t of res.results) ids.push(t.mangaId)
        meta = res.metadata
        if (!meta) break
    }
    check('listing paginates without duplicate ids',
        ids.length > 25 && new Set(ids).size === ids.length,
        `${ids.length} items, ${new Set(ids).size} unique`)

    // ---- English only ----
    // Ground truth: the site's own Chinese listing. None of its galleries may
    // appear in anything this source returns.
    const chineseHtml = await raw('https://asmhentai.com/language/chinese/')
    const chineseIds = [...new Set([...chineseHtml.matchAll(/href="\/g\/(\d+)\//g)].map((m) => m[1]))]
    check('no gallery from the Chinese listing survives',
        chineseIds.length > 0 && !ids.some((id) => chineseIds.includes(id)),
        `${chineseIds.length} Chinese galleries checked against ${ids.length} results`)

    const chineseSample = chineseIds[0]
    await expectGateThrow(`a Chinese gallery refuses to open (${chineseSample})`,
        () => s.getMangaDetails(chineseSample))

    // ---- the standing exclusions ----
    // Ground truth: the site's own yaoi listing.
    const yaoiHtml = await raw('https://asmhentai.com/tag/yaoi/')
    const yaoiIds = [...new Set([...yaoiHtml.matchAll(/href="\/g\/(\d+)\//g)].map((m) => m[1]))]
    check('no gallery from the yaoi listing survives',
        yaoiIds.length > 0 && !ids.some((id) => yaoiIds.includes(id)),
        `${yaoiIds.length} yaoi galleries checked`)
    await expectGateThrow(`a yaoi gallery refuses to open (${yaoiIds[0]})`,
        () => s.getMangaDetails(yaoiIds[0]))

    const crossHtml = await raw('https://asmhentai.com/tag/crossdressing/')
    const crossIds = [...new Set([...crossHtml.matchAll(/href="\/g\/(\d+)\//g)].map((m) => m[1]))]
    await expectGateThrow(`a crossdressing gallery refuses to open (${crossIds[0]})`,
        () => s.getMangaDetails(crossIds[0]))

    // ---- details / chapters / pages ----
    const plain = ids.find((id) => /^\d+$/.test(id))
    const d = await s.getMangaDetails(plain)
    const labels = (d.mangaInfo.tags[0]?.tags ?? []).map((t) => t.label)
    check('details parse',
        d.mangaInfo.titles[0]?.length > 0 && d.mangaInfo.image.startsWith('https://') && labels.length > 0,
        `"${d.mangaInfo.titles[0]?.slice(0, 40)}" tags=${labels.length}`)
    check('no banned label reaches the details screen',
        !labels.some((l) => /yaoi|\bmales only\b|tomgirl|crossdress|ugly bastard|^bald$|^fat$/i.test(l)),
        labels.slice(0, 5).join(', ').slice(0, 70))

    const chapters = await s.getChapters(plain)
    check('a lone gallery is a single chapter', chapters.length === 1, `${chapters.length} chapter(s)`)

    const pages = await s.getChapterDetails(plain, chapters[0].id)
    check('pages resolve', pages.pages.length > 0 && pages.pages.every((p) => p.startsWith('https://')),
        `${pages.pages.length} pages from ${new URL(pages.pages[0]).host}`)

    const probe = await fetch(pages.pages[0], { headers: { 'user-agent': UA, referer: 'https://asmhentai.com/' } })
    const head = Buffer.from(await probe.arrayBuffer()).subarray(0, 12)
    const looksImage = (head[0] === 0xFF && head[1] === 0xD8)
        || head.toString('ascii', 1, 4) === 'PNG'
        || head.toString('ascii', 8, 12) === 'WEBP'
    check('first page fetches real image bytes', probe.ok && looksImage,
        `${probe.status} ${probe.headers.get('content-type')}`)

    // ---- volume merging ----
    const merged = ids.filter((id) => id.startsWith('s:'))
    note('merged series among the listing', `${merged.length} of ${ids.length}`)
    if (merged.length > 0) {
        const volumes = await s.getChapters(merged[0])
        check('a merged series lists its volumes as ordered chapters',
            volumes.length >= 1
                && new Set(volumes.map((c) => c.id)).size === volumes.length
                && volumes.every((c, i) => i === 0 || volumes[i - 1].chapNum <= c.chapNum),
            `${merged[0].slice(0, 34)} -> ${volumes.length}: ${volumes.map((c) => c.chapNum).join(',')}`)
    }

    // ---- search ----
    const search = await s.getSearchResults({ title: 'maid', includedTags: [], excludedTags: [], parameters: {} }, undefined)
    check('search returns results', search.results.length > 0, `${search.results.length} results`)
    check('search results respect the English rule',
        !search.results.some((r) => chineseIds.includes(r.mangaId)),
        `${search.results.length} checked against the Chinese listing`)

    // ---- tag catalogs ----
    const tags = await s.getSearchTags()
    const offered = tags.flatMap((sec) => sec.tags.map((t) => t.label.toLowerCase()))
    check('tag catalogs offered', tags.length === 2 && tags.every((sec) => sec.tags.length > 20),
        tags.map((sec) => `${sec.id}:${sec.tags.length}`).join(' '))
    check('catalogs are alphabetical',
        tags.every((sec) => {
            const labels = sec.tags.map((t) => t.label)
            return JSON.stringify(labels) === JSON.stringify([...labels].sort((a, b) => a.localeCompare(b)))
        }),
        tags.map((sec) => `${sec.id}: ${sec.tags[0]?.label}`).join(' | '))
    // "females only" contains "males only", so the boundary matters here as
    // much as it does in the source: without it this check demands that the
    // catalog drop female-only galleries, the opposite of the rule.
    check('banned names scrubbed from the catalogs',
        !offered.some((l) => /yaoi|\bmales only\b|tomgirl|crossdress|ugly bastard|^bald$/i.test(l)),
        `${offered.length} names offered, none banned`)

    // A populated tag, not simply the alphabetically first: the catalog now
    // leads with oddities like ".labo", whose page the site redirects away.
    const browsable = tags[0]?.tags.find((t) => t.label === 'big breasts') ?? tags[0]?.tags[0]
    const byTag = await s.getSearchResults({ title: '', includedTags: [browsable], excludedTags: [], parameters: {} }, undefined)
    check('selecting a catalog tag browses it', byTag.results.length > 0,
        `${browsable?.id} -> ${byTag.results.length} results`)

    console.log(`\nrequests used: ${requests}`)
    console.log(failures > 0 ? `${failures} check(s) failed` : 'all checks passed')
    process.exit(failures > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
