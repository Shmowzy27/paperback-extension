import { SourceInfo } from '@paperback/types'

import { NHentai, NHentaiInfo } from '../NHentai/NHentai'

/**
 * A second nhentai source, by request, with every rule the first one carries:
 * English only, the standing content exclusions, no anime or game parodies,
 * include and exclude filters in alphabetical order, and every series merged
 * into one entry -- by volume number, the site's multi-work tag, the creator's
 * credit and the form of the subtitle -- with a refusal that says why.
 *
 * It carries them because it *is* the first source, under its own id. Nothing
 * here is copied, so a fix to one is a fix to both; this repository's AsmHentai
 * once kept its own copy of the series rules, and it fell behind.
 *
 * Its own id is the point of it: Paperback keys a library on the source id, so
 * this one starts clean -- none of the single-book or non-English entries saved
 * from "nhentai (Filtered)" before the rules existed come with it.
 */
export const NHentaiNewInfo: SourceInfo = {
    ...NHentaiInfo,
    version: '1.0.1',
    name: 'nhentai (new)',
    description: 'nhentai with every rule of the filtered source -- English only, the standing exclusions, no parodies, and each series merged into one entry -- under a library of its own.'
}

export class NHentaiNew extends NHentai {
    protected readonly displayName: string = NHentaiNewInfo.name
}
