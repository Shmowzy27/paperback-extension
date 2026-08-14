import type { CheerioAPI } from "cheerio";

import { DOMAIN, type GalleryCard } from "./models";

/** Gallery cards are identical across the listing, explore and search pages. */
export function parseGalleryCards($: CheerioAPI): GalleryCard[] {
  const cards: GalleryCard[] = [];

  for (const element of $("a[href^='/view/']").toArray()) {
    const anchor = $(element);
    const id = /^\/view\/(\d+)$/.exec(anchor.attr("href") ?? "")?.[1];
    if (id == undefined) continue;

    const thumbnailUrl = anchor.find("figure.image img").attr("src");
    if (thumbnailUrl == undefined) continue;

    const title = anchor.find(".card-header-title").text().trim();
    if (title.length === 0) continue;

    cards.push({ id, title, thumbnailUrl });
  }

  return cards;
}

/**
 * The listing renders a fixed 30 cards per page, so a short page is the last
 * page. There is no "next" affordance in the markup to key off instead.
 */
export function hasNextPage(cards: GalleryCard[]): boolean {
  return cards.length >= 30;
}

/**
 * Every linked value carries a nested `.small-tag-count` badge ("Homunculus (68)"),
 * which has to come off before the text is usable as a name or a search term.
 */
function cleanText($: CheerioAPI, element: Parameters<CheerioAPI>[0]): string {
  return $(element).clone().find(".small-tag-count").remove().end().text().trim();
}

/** Reads a row out of the `table.view-page-details` label/value table. */
function detailRow($: CheerioAPI, label: string) {
  return $("table.view-page-details tr")
    .filter((_, row) => $(row).find("td.viewcolumn").text().trim() === label)
    .first()
    .find("td")
    .not(".viewcolumn")
    .first();
}

function detailText($: CheerioAPI, label: string): string {
  return cleanText($, detailRow($, label));
}

export interface GalleryDetails {
  title: string;
  coverUrl: string;
  artist: string;
  description: string;
  pageCount: number;
  publishedAt?: Date;
  tags: { id: string; title: string }[];
  parody: string;
  publisher: string;
}

/**
 * Tag links render their name with a usage count baked into the text
 * ("blowjob (8,359)"), so the href is the only clean source. It also happens to
 * be the exact term the site's own search expects back.
 */
function tagFromHref(href: string): string | undefined {
  const raw = /\/\?q=tag:(.+)$/.exec(href)?.[1];
  if (raw == undefined) return undefined;

  const decoded = decodeURIComponent(raw.replace(/\+/g, " ")).trim();
  const unquoted = decoded.replace(/^"|"$/g, "").trim();
  return unquoted.length > 0 ? unquoted : undefined;
}

export function parseGalleryDetails($: CheerioAPI): GalleryDetails {
  const tags = $("table.view-page-details a[href*='/?q=tag:']")
    .toArray()
    .map((element) => tagFromHref($(element).attr("href") ?? ""))
    .filter((title): title is string => title != undefined)
    .map((title) => ({ id: title, title }));

  const published = detailText($, "Published");
  const parsedDate = published.length > 0 ? new Date(published) : undefined;

  return {
    title: $("h1.title").first().text().trim(),
    coverUrl: $("figure.image img").first().attr("src") ?? "",
    artist: detailText($, "Artist"),
    description: detailText($, "Description"),
    pageCount: Number.parseInt(detailText($, "Pages"), 10) || 0,
    publishedAt:
      parsedDate != undefined && !Number.isNaN(parsedDate.getTime()) ? parsedDate : undefined,
    tags,
    parody: detailText($, "Parody"),
    publisher: detailText($, "Publisher"),
  };
}

/** Pulls the encrypted manifest out of the lone `initReader(...)` call. */
export function extractReaderPayload(html: string): string {
  const payload = /initReader\("([^"]+)"/.exec(html)?.[1];
  if (payload == undefined) {
    throw new Error("Could not find the reader payload; the site layout may have changed.");
  }
  return payload;
}

export function galleryUrl(id: string): string {
  return `${DOMAIN}/view/${id}`;
}
