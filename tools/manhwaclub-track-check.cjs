const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
const identity = (x) => x
const store = {}
global.App = {
    createRequest: identity, createPartialSourceManga: identity, createSourceManga: identity,
    createMangaInfo: identity, createTag: identity, createTagSection: identity,
    createChapter: identity, createChapterDetails: identity, createPagedResults: identity,
    createHomeSection: (i) => ({ ...i }),
    createDUISection: (i) => i, createDUISelect: (i) => i,
    createDUIBinding: (i) => i,
    createSourceStateManager: () => ({
        store: async (k, v) => { store[k] = v },
        retrieve: async (k) => store[k]
    }),
    createRequestManager: (opts) => ({
        getDefaultUserAgent: async () => UA,
        schedule: async (request) => {
            const gap = 1000 / (opts.requestsPerSecond || 3)
            const wait = Math.max(0, (global.__last || 0) + gap - Date.now())
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))
            global.__last = Date.now()
            const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request
            const res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {}, body: req.data })
            return { data: await res.text(), status: res.status, headers: {}, request: req }
        }
    })
}
const { Sources } = require(require('node:path').join(__dirname, '..', 'bundles', 'ManhwaClub', 'source.js'))
let bad = 0
const check = (l, ok, d) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); if (!ok) bad++ }
;(async () => {
    const s = new Sources.ManhwaClub()

    const menu = await s.getSourceMenu()
    const rows = await menu.rows()
    check('settings expose a track selector', rows.length === 1 && rows[0].options.join(',') === 'both,translated,raw',
        `${rows[0]?.label}: ${rows[0]?.options?.join(', ')}`)
    check('labels are readable', (await rows[0].labelResolver('translated')) === 'Translated only')

    const both = await s.getChapters('manitto')
    check('default shows both tracks', new Set(both.map((c) => c.group)).size === 2, `${both.length} chapters`)

    await rows[0].value.set(['translated'])
    const tr = await s.getChapters('manitto')
    check('translated-only hides raws', tr.every((c) => c.group === 'Translated') && tr.length < both.length,
        `${tr.length} chapters, groups=${[...new Set(tr.map((c) => c.group))].join(',')}`)

    await rows[0].value.set(['raw'])
    const raw = await s.getChapters('manitto')
    check('raw-only hides translations', raw.every((c) => c.group === 'Raw') && raw.length < both.length,
        `${raw.length} chapters, groups=${[...new Set(raw.map((c) => c.group))].join(',')}`)

    check('selection persists for the picker', (await rows[0].value.get())[0] === 'raw')
    process.exit(bad > 0 ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
