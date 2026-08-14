import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "HentaiNexus",
  description: "Extension that pulls content from hentainexus.com.",
  version: "1.0.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.ADULT,
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [],
  developers: [
    {
      name: "Shmowzy27",
      github: "https://github.com/Shmowzy27",
    },
  ],
} satisfies ExtensionInfo;
