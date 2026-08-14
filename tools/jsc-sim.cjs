/*
 * Evaluates the built bundle in a bare VM context.
 *
 * Paperback runs JavaScriptCore, which has none of Node's globals. A dependency
 * that touches `Buffer`, `process` or similar at module scope takes the whole
 * source down on device -- every method then reports "does not have a
 * JavaScript implementation" -- while behaving perfectly under Node. cheerio
 * 1.2.0 did exactly this, which is why the version is pinned.
 *
 * The context below deliberately omits require/module/exports/process/Buffer.
 */
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

const BUNDLE = path.join(__dirname, '..', 'bundles', 'HentaiNexus', 'source.js')
const SOURCE = 'HentaiNexus'
const REQUIRED_METHODS = [
    'getMangaDetails',
    'getChapters',
    'getChapterDetails',
    'getSearchResults',
    'getHomePageSections',
    'getViewMoreItems',
    'getCloudflareBypassRequestAsync'
]

const identity = (x) => x
const stubApp = () => ({
    createRequest: identity,
    createPartialSourceManga: identity,
    createSourceManga: identity,
    createMangaInfo: identity,
    createTag: identity,
    createTagSection: identity,
    createChapter: identity,
    createChapterDetails: identity,
    createPagedResults: identity,
    createHomeSection: identity,
    createRequestManager: () => ({
        getDefaultUserAgent: async () => 'ua',
        schedule: async () => ({})
    })
})

function fail(message) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
}

if (!fs.existsSync(BUNDLE)) fail(`bundle not found at ${BUNDLE}; run "npm run bundle" first`)

const context = vm.createContext({ App: stubApp(), console })

try {
    new vm.Script(fs.readFileSync(BUNDLE, 'utf8'), { filename: BUNDLE }).runInContext(context)
} catch (error) {
    fail(`bundle threw while evaluating: ${error.constructor.name}: ${error.message}`)
}

const sources = context.Sources
if (!sources) fail('bundle evaluated but never defined Sources')
if (!sources[SOURCE]) fail(`Sources.${SOURCE} is undefined`)

let instance
try {
    instance = new sources[SOURCE]()
} catch (error) {
    fail(`constructor threw: ${error.constructor.name}: ${error.message}`)
}

const missing = REQUIRED_METHODS.filter((name) => typeof instance[name] !== 'function')
if (missing.length > 0) fail(`missing methods: ${missing.join(', ')}`)

console.log(`OK: ${SOURCE} evaluates and exposes all ${REQUIRED_METHODS.length} methods without Node globals`)
