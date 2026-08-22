/*
 * Checks the standing name-based exclusions against the words they must catch
 * and, just as importantly, the ones they must not.
 *
 * "old" is the reason this exists, and it went wrong twice. Matched loosely it
 * takes cuckold, gold, bold and soldier. Anchored to the start of a word it
 * still took "old lady" and would have taken "grandmother" had "grand" been
 * added the same way -- but the exclusion was only ever about older *men*.
 * So the terms are now spelled out (old man, older man, old guy, grandfather,
 * grandpa, granddad, gramps, dilf), and the older-women tags are listed below
 * as words that must survive. All of them are real: asmhentai carries "old
 * lady", "grandmother" and "granddaughter", and nhentai has 502 galleries
 * under the first and 396 under the second.
 *
 * The pattern is read out of the built bundles rather than restated here, so
 * this cannot drift away from what actually ships.
 */
const fs = require('node:fs')
const path = require('node:path')

const MUST_MATCH = [
    'yaoi', 'boys love', 'shounen ai', 'males only', 'tomgirl', 'crossdressing',
    'ugly bastard', 'bald', 'fat', 'gigantic breasts',
    // the older-male category, which is what "old" was ever about
    'old man', 'old men', 'old guy', 'older man younger woman', 'older men',
    'grandfather', 'grandpa', 'granddad', 'grand-dad', 'gramps', 'dilf',
    'group', 'group sex', 'bbm', 'gang rape', 'gangbang', 'orgy',
    // two or more male-bodied participants
    'mmf threesome', 'mmm threesome', 'mmt threesome', 'mtf threesome',
    'ttf threesome', 'ttm threesome', 'mmmf',
    // animals and creatures
    'monster', 'monster girl', 'tentacles', 'tentacle', 'alien', 'alien girl',
    'bestiality', 'low bestiality', 'furry', 'animal on animal',
    'human on furry', 'octopus', 'slime', 'slime girl', 'insect', 'snake',
    'spider', 'worm', 'centaur', 'minotaur', 'horse', 'horse cock', 'dog',
    'dog girl', 'cat', 'pig', 'fish', 'frog', 'bear', 'wolf', 'wolf girl'
]

const MUST_NOT_MATCH = [
    // Words that merely contain "old". Confirmed harmless by the maintainer.
    'cuckold', 'gold', 'golden shower', 'golden bazooka', 'goldfish circus',
    'bold', 'soldier', 'household', 'scold',
    // Older *women* are a different category and stay. These are real tags:
    // asmhentai carries all three, and nhentai has 502 galleries under "old
    // lady" and 396 under "grandmother".
    'old lady', 'grandmother', 'granddaughter',
    // "grand" as an ordinary word, likewise real tags on asmhentai.
    'grand deer', 'grand plie',
    // "females only" contains "males only". Missing that boundary once meant
    // female-only galleries were excluded, the opposite of the rule's point.
    'females only', 'sole female', 'female only',
    // one male is not "multiple males", and animal *ears* are not an animal.
    'ffm threesome', 'fff threesome', 'kemonomimi', 'kemonomimi | animal ears',
    'catgirl', 'cat ears',
    // ordinary tags that must survive
    'big breasts', 'glasses', 'schoolgirl uniform', 'blowjob', 'stockings',
    'elf', 'sole female', 'nakadashi', 'ahegao', 'swimsuit', 'maid', 'nurse',
    'friendship', 'growth', 'alienation'
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
            'bald', 'gigantic breasts', 'old man', 'grandfather', 'dilf', 'group', 'bbm',
            'mmf threesome', 'monster', 'tentacles', 'alien']
        const missing = required.filter((word) => !all.includes(word))

        check(`${name}: every required tag is named`, missing.length === 0,
            missing.join(', ') || `${all.length} names negated`)

        // Named exactly, so the older-women tags cannot be swept up by
        // accident the way a pattern could sweep them.
        const overreach = ['old lady', 'grandmother', 'granddaughter'].filter((word) => all.includes(word))
        check(`${name}: leaves older-women tags alone`, overreach.length === 0,
            overreach.join(', ') || 'old lady and grandmother untouched')
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
