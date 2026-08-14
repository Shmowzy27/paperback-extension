import { CloudflareError } from "@paperback/types";

import { DOMAIN } from "./models";

/**
 * Cloudflare answers a challenge with 403/503 and an HTML body rather than the
 * page we asked for. Throwing `CloudflareError` makes the app surface its
 * "bypass" banner instead of showing the user a parse failure.
 */
export async function fetchHtml(url: string): Promise<string> {
  const [response, buffer] = await Application.scheduleRequest({
    url,
    method: "GET",
    headers: {
      referer: `${DOMAIN}/`,
      "user-agent": await Application.getDefaultUserAgent(),
    },
  });

  if (response.status === 403 || response.status === 503) {
    throw new CloudflareError({ url: `${DOMAIN}/`, method: "GET" });
  }

  if (response.status !== 200) {
    throw new Error(`Request to ${url} failed with status ${response.status}.`);
  }

  return Application.arrayBufferToUTF8String(buffer);
}
