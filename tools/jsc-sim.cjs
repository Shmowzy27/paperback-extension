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

const BUNDLES = path.join(__dirname, '..', 'bundles')
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

if (!fs.existsSync(BUNDLES)) fail(`no bundles directory at ${BUNDLES}; run "npm run bundle" first`)

// Every bundled source is checked, not just one: each ships its own copy of the
// dependencies, so one source can be taken down by a module-scope Node global
// while the others stay fine.
const names = fs.readdirSync(BUNDLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(BUNDLES, entry.name, 'source.js')))
    .map((entry) => entry.name)

if (names.length === 0) fail(`no source.js found under ${BUNDLES}; run "npm run bundle" first`)

for (const name of names) {
    const bundle = path.join(BUNDLES, name, 'source.js')
    const context = vm.createContext({ App: stubApp(), console })

    try {
        new vm.Script(fs.readFileSync(bundle, 'utf8'), { filename: bundle }).runInContext(context)
    } catch (error) {
        fail(`${name} threw while evaluating: ${error.constructor.name}: ${error.message}`)
    }

    const sources = context.Sources
    if (!sources) fail(`${name} evaluated but never defined Sources`)

    // The bundle names its own export, which need not match the directory.
    const exported = Object.keys(sources).filter((key) => typeof sources[key] === 'function')
    if (exported.length === 0) fail(`${name} defined Sources but exported no class`)

    for (const key of exported) {
        let instance
        try {
            instance = new sources[key]()
        } catch (error) {
            fail(`${name}.${key} constructor threw: ${error.constructor.name}: ${error.message}`)
        }

        const missing = REQUIRED_METHODS.filter((method) => typeof instance[method] !== 'function')
        if (missing.length > 0) fail(`${name}.${key} missing methods: ${missing.join(', ')}`)
    }

    console.log(`OK: ${name} evaluates and exposes all ${REQUIRED_METHODS.length} methods without Node globals`)
}

console.log(`OK: ${names.length} bundled sources pass`)
