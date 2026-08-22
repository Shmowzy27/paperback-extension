/*
 * Checks the standing name-based exclusions against the words they must catch
 * and, just as importantly, the ones they must not.
 *
 * `\bold` is the reason this exists. Matching "old" loosely would also take
 * cuckold, gold, bold and soldier, so it is anchored at the start of a word
 * only -- in those four the letters sit mid-word with no boundary before them.
 * The same care applies to `\bgroup\b` and `\balien\b`.
 *
 * The pattern is read out of the built bundles rather than restated here, so
 * this cannot drift away from what actually ships.
 */
const fs = require('node:fs')
const path = require('node:path')

const MUST_MATCH = [
    'yaoi', 'boys love', 'shounen ai', 'males only', 'tomgirl', 'crossdressing',
    'ugly bastard', 'bald', 'fat', 'gigantic breasts',
    'old man', 'old guy', 'older man younger woman', 'dilf',
    'group', 'group sex', 'bbm', 'mmf threesome', 'mmmf',
    'monster', 'monster girl', 'tentacles', 'tentacle', 'alien'
]

const MUST_NOT_MATCH = [
    // the \bold traps
    'cuckold', 'gold', 'golden shower', 'bold', 'soldier', 'household', 'scold',
    // ordinary tags that must survive
    'big breasts', 'glasses', 'schoolgirl uniform', 'blowjob', 'stockings',
    'elf', 'sole female', 'nakadashi', 'ahegao', 'swimsuit', 'maid', 'nurse',
    'group of friends'.replace('group of friends', 'friendship'),
    'grouping'.replace('grouping', 'growth'),
    'alienation'
]

let failures = 0
const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

const sources = ['AsmHentai', 'NHentai', 'HentaiHere', 'Hentai2Read']

for (const name of sources) {
    const bundle = path.join(__dirname, '..', 'bundles', name, 'source.js')
    if (!fs.existsSync(bundle)) continue

    const code = fs.readFileSync(bundle, 'utf8')

    // nhentai has no label pattern: it names each excluded tag, negates those
    // names in every search, and checks resolved ids on the way back. So the
    // names it ships are what gets audited there.
    if (name === 'NHentai') {
        // The bundler re-quotes with double quotes, so both forms are accepted.
        const names = [...code.matchAll(/name:\s*["']([^"']+)["']/g)].map((m) => m[1].toLowerCase())
        const namesOnly = /NH_BANNED_NAMES_ONLY\s*=\s*\[([^\]]*)\]/.exec(code)
        const extra = namesOnly ? [...namesOnly[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1].toLowerCase()) : []
        const all = names.concat(extra)

        const required = ['yaoi', 'males only', 'tomgirl', 'crossdressing', 'ugly bastard',
            'bald', 'gigantic breasts', 'old man', 'dilf', 'group', 'bbm',
            'mmf threesome', 'monster', 'tentacles', 'alien']
        const missing = required.filter((word) => !all.includes(word))

        check(`${name}: every required tag is named`, missing.length === 0,
            missing.join(', ') || `${all.length} names negated`)
        continue
    }

    // The literal as it ships, taken straight out of the bundle.
    const found = /BANNED_LABELS\s*=\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/.exec(code)
    if (!found) {
        check(`${name}: blocklist found in bundle`, false, 'no BANNED_LABELS literal')
        continue
    }

    let pattern
    try {
        pattern = eval(found[1])
    } catch (error) {
        check(`${name}: blocklist compiles`, false, error.message)
        continue
    }

    const missed = MUST_MATCH.filter((word) => !pattern.test(word))
    const wrong = MUST_NOT_MATCH.filter((word) => pattern.test(word))

    check(`${name}: catches everything it must`, missed.length === 0, missed.join(', ') || `${MUST_MATCH.length} terms`)
    check(`${name}: catches nothing it must not`, wrong.length === 0, wrong.join(', ') || `${MUST_NOT_MATCH.length} safe words`)
}

console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures > 0 ? 1 : 0)
