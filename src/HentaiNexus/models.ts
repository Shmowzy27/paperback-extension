export const DOMAIN = "https://hentainexus.com";

/**
 * The reader payload is keyed to the bare hostname, not the full origin.
 * If the site ever moves domains this constant has to move with it, otherwise
 * the XOR pass in `decodeReaderPayload` produces garbage instead of JSON.
 */
export const HOSTNAME = "hentainexus.com";

export const SECTION_NEW = "new";
export const SECTION_POPULAR = "popular";
export const SECTION_RECOMMENDED = "recommended";

/** One entry of the decoded reader manifest. */
export interface ReaderEntry {
  type: string;
  label: string;
  url_label: string;
  image_avif: string;
  image_fallback: string;
}

export interface GalleryCard {
  id: string;
  title: string;
  thumbnailUrl: string;
}

export type ImageFormat = "avif" | "fallback";
