/**
 * Content rules shared by the doujinshi sources, beside SeriesMerge.ts for the
 * same reason: written once, imported everywhere, so a sources's copy cannot
 * fall behind the others'. (A src/shared folder breaks the Paperback
 * toolchain, which bundles every folder under src as a source.)
 */

/**
 * The standing rule on group scenes, in the user's words (2026-09-12): one man
 * with several women is fine; several men with one woman is not -- "Mesu no Ie
 * III is group because it is ffm threesome. It is okay, but not mmf
 * threesome."
 *
 * So "group" is no longer excluded on its own. A group is refused when the
 * gallery says there is one woman, or says nothing of there being one man:
 * with no sign of who is involved, a group is not assumed to be the allowed
 * kind. The several-men tags themselves -- mmf threesome, gangbang, gang rape,
 * orgy -- stay excluded outright, in each source's own list.
 */
export const GROUP_LABEL = /\bgroup\b/i

/** One man among several women: sole male, harem, ffm/fffm, mff -- "Threesome (MFF)" included. */
export const ONE_MALE_LABEL = /\bsole male\b|\bharem\b|\bf{2,}m\b|\bmf{2,}\b/i

/** One woman: with a group, that is several men. */
export const ONE_FEMALE_LABEL = /\bsole female\b/i

/**
 * One woman with several men, as a genre. Excluded outright in every source's
 * own list; and never a sign of one man here, though it contains "harem".
 */
export const REVERSE_HAREM_LABEL = /reverse[- ]?harem/i

/** The group label that gets a gallery refused, or undefined when it may be shown. */
export const groupRefusal = (labels: string[]): string | undefined => {
    const group = labels.find((label) => GROUP_LABEL.test(label))
    if (group == undefined) return undefined
    if (labels.some((label) => ONE_FEMALE_LABEL.test(label) || REVERSE_HAREM_LABEL.test(label))) return group
    return labels.some((label) => ONE_MALE_LABEL.test(label) && !REVERSE_HAREM_LABEL.test(label)) ? undefined : group
}

/** The same rule on a card's tag ids, where the source knows which ids mean what. */
export const groupRefusedByIds = <K>(ids: K[], rule: { group: K[]; oneMale: K[]; oneFemale: K[] }): boolean => {
    if (!ids.some((id) => rule.group.includes(id))) return false
    if (ids.some((id) => rule.oneFemale.includes(id))) return true
    return !ids.some((id) => rule.oneMale.includes(id))
}

/** What a refusal under the group rule says. */
export const GROUP_REFUSAL_MESSAGE =
    'This gallery has several men with one woman, or a group with no sign of there being one man -- excluded by your settings, so it will not be shown.'

/**
 * The standing exclusions by name -- the pattern AsmHentai, HentaiHere,
 * Hentai2Read and Hentai3z each carry as BANNED_LABELS -- for a source that
 * checks tag names without keeping its own copy (nhentai).
 */
export const STANDING_LABELS = /yaoi|boys?.?love|shounen[ -]?ai|\bmales only\b|tomgirl|crossdress|ugly bastard|\bbald\b|\bfat\b|gigantic breasts|\bold\s*m[ae]n\b|\bolder\s*m[ae]n\b|\bold\s*guy\b|\bgrandfather\b|\bgrandpa\b|\bgrand-?dad\b|\bgramps\b|\bdilf\b|reverse[- ]?harem|\bbbm\b|\bgang|\borgy\b|\b[mt]{2,}[mtf]\s*(?:threesome|foursome)\b|\bmm+f?\b|bestial|\bfurry\b|animal on|human on furry|octopus|\btentacl|\bmonster|\bslime\b|\binsect|\bsnake\b|\bspider\b|\bworm\b|\bcentaur\b|\bminotaur\b|\bhorse\b|\bdog\b|\bcat\b(?!\s*ears)|\bpig\b|\bfish\b|\bfrog\b|\bbird (?:girl|boy)\b|\bbear\b|\bwolf\b|\balien\b/i

/**
 * Excluded tags the standing pattern never named, checked against tag names
 * only -- never titles, where "The Fox Wife" or "Honey Bee" are just words:
 *
 * - every animal and creature a site files as a tag, the "X girl" / "X boy"
 *   forms included: "all animal-related tags" and "no monsters" -- fox, cow,
 *   shark, mouse, goat, dragon, lamia, harpy, mermaid, orc, goblin and the
 *   rest. The standing pattern stopped at a dozen animals, so Hentai3z offered
 *   "Fox Girl", "Cow Girl" and "Orc" as filters and showed their titles.
 * - male-to-male content under other names: "bisexual" (a man with men as
 *   well as women), "male pregnancy", "cuntboy" / "pussyboy", and "josou"
 *   (crossdressing).
 *
 * Left alone on purpose: "cowgirl" (a position), "bunny girl" (a costume),
 * "catgirl", "cat ears", "kemonomimi" and "animal ears" (a person), "ponygirl"
 * and "human pet" (role-play).
 */
export const TAG_ONLY_LABELS = /\b(?:fox|cow|cowman|bat|bee|shark|mouse|rat|squirrel|racc?oon|monkey|gorilla|ape|panda|lion|lioness|tiger|panther|leopard|hyena|giraffe|elephant|kangaroo|otter|dolphin|whale|eel|squid|lizard|reptile|dinosaur|dragon|chicken|sheep|goat|deer|rabbit|donkey|pegasus|unicorn|slug|snail|maggot|lamia|harpy|mermaid|merman|orc|goblin|kappa|parasite|catboy)\b|\bbunny\s*boy\b|\bbisexual\b|\bmale pregnancy\b|\bcuntboy\b|pussyboy|\bjosou\b/i

/** Whether a tag name is excluded by the standing rules. */
export const bannedTagName = (name: string): boolean => STANDING_LABELS.test(name) || TAG_ONLY_LABELS.test(name)
