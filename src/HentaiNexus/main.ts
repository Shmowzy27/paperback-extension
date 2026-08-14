import {
  BasicRateLimiter,
  ContentRating,
  CookieStorageInterceptor,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type Form,
  type Metadata,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";
import * as cheerio from "cheerio";

import { decodeReaderPayload } from "./decoder";
import { DOMAIN, SECTION_NEW, SECTION_POPULAR, type GalleryCard } from "./models";
import { fetchHtml } from "./network";
import {
  extractReaderPayload,
  galleryUrl,
  hasNextPage,
  parseGalleryCards,
  parseGalleryDetails,
} from "./parsers";
import type HentaiNexusConfig from "./pbconfig";
import { HentaiNexusSettingsForm, shortensTitles, usesAvif } from "./settings";

const BRACKETED = /(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/g;

function displayTitle(title: string): string {
  if (!shortensTitles()) return title;
  const shortened = title.replace(BRACKETED, "").trim();
  return shortened.length > 0 ? shortened : title;
}

function toSearchResult(card: GalleryCard): SearchResultItem {
  return {
    mangaId: card.id,
    title: displayTitle(card.title),
    imageUrl: card.thumbnailUrl,
    contentRating: ContentRating.ADULT,
  };
}

function toCarouselItem(card: GalleryCard): DiscoverSectionItem {
  return {
    type: "simpleCarouselItem",
    mangaId: card.id,
    title: displayTitle(card.title),
    imageUrl: card.thumbnailUrl,
    contentRating: ContentRating.ADULT,
  };
}

/** Paging state travels as opaque `Metadata`, so narrow it back to a page number. */
function pageOf(metadata: Metadata | undefined): number {
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const page = metadata["page"];
    if (typeof page === "number") return page;
  }
  return 1;
}

/** Every listing surface paginates as `/page/{n}`, with filters carried in `?q=`. */
function listingUrl(page: number, query?: string): string {
  const search = query != undefined && query.length > 0 ? `?q=${encodeURIComponent(query)}` : "";
  return `${DOMAIN}/page/${page}${search}`;
}

export class HentaiNexusExtension implements ExtensionImpl<typeof HentaiNexusConfig> {
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 3,
    bufferInterval: 1,
    ignoreImages: true,
  });

  cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });

  async initialise(): Promise<void> {
    this.globalRateLimiter.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
  }

  // Discover

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: SECTION_NEW,
        title: "New Releases",
        type: DiscoverSectionType.simpleCarousel,
      },
      {
        id: SECTION_POPULAR,
        title: "Popular",
        type: DiscoverSectionType.simpleCarousel,
      },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata?: Metadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = pageOf(metadata);

    // `/explore/hot` is a fixed, curated list of 30 that ignores any page
    // parameter, so it is fetched once and never advertises a next page.
    // Advertising one would just replay the same 30 titles forever.
    const isPopular = section.id === SECTION_POPULAR;
    const url = isPopular ? `${DOMAIN}/explore/hot` : listingUrl(page);

    const cards = parseGalleryCards(cheerio.load(await fetchHtml(url)));

    return {
      items: cards.map(toCarouselItem),
      metadata: !isPopular && hasNextPage(cards) ? { page: page + 1 } : undefined,
    };
  }

  // Search

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = pageOf(metadata);
    const cards = parseGalleryCards(cheerio.load(await fetchHtml(listingUrl(page, query.title))));

    return {
      items: cards.map(toSearchResult),
      metadata: hasNextPage(cards) ? { page: page + 1 } : undefined,
    };
  }

  // Details

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = cheerio.load(await fetchHtml(galleryUrl(mangaId)));
    const details = parseGalleryDetails($);

    const additionalInfo: Record<string, string> = {};
    if (details.pageCount > 0) additionalInfo["Pages"] = String(details.pageCount);
    if (details.parody.length > 0) additionalInfo["Parody"] = details.parody;
    if (details.publisher.length > 0) additionalInfo["Publisher"] = details.publisher;

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: displayTitle(details.title),
        secondaryTitles: details.title === displayTitle(details.title) ? [] : [details.title],
        thumbnailUrl: details.coverUrl,
        synopsis: details.description,
        author: details.artist,
        artist: details.artist,
        contentRating: ContentRating.ADULT,
        status: "Completed",
        shareUrl: galleryUrl(mangaId),
        additionalInfo,
        tagGroups:
          details.tags.length > 0
            ? [{ id: "tags", title: "Tags", tags: details.tags }]
            : undefined,
      },
    };
  }

  // Chapters

  /** A gallery is a single self-contained book, so it maps to exactly one chapter. */
  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    return [
      {
        chapterId: sourceManga.mangaId,
        sourceManga,
        langCode: "en",
        chapNum: 1,
        title: "Gallery",
      },
    ];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const html = await fetchHtml(`${DOMAIN}/read/${chapter.chapterId}`);
    const entries = decodeReaderPayload(extractReaderPayload(html));
    const preferAvif = usesAvif();

    const pages = entries
      .filter((entry) => entry.type === "image")
      .map((entry) => (preferAvif ? entry.image_avif : entry.image_fallback))
      .filter((url) => typeof url === "string" && url.length > 0);

    if (pages.length === 0) {
      throw new Error(`No pages were decoded for gallery ${chapter.chapterId}.`);
    }

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    };
  }

  // Settings

  async getSettingsForm(): Promise<Form> {
    return new HentaiNexusSettingsForm();
  }

  // Cloudflare

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    for (const cookie of cookies) {
      this.cookieStorageInterceptor.setCookie(cookie);
    }
  }
}

export const HentaiNexus = new HentaiNexusExtension();
