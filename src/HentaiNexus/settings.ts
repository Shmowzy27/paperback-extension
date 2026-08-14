import { Form, Section, ToggleRow, type FormSectionElement } from "@paperback/types";

const PREF_USE_AVIF = "pref_use_avif";
const PREF_SHORTEN_TITLES = "pref_shorten_titles";

export function usesAvif(): boolean {
  return (Application.getState(PREF_USE_AVIF) as boolean | undefined) ?? false;
}

export function shortensTitles(): boolean {
  return (Application.getState(PREF_SHORTEN_TITLES) as boolean | undefined) ?? false;
}

export class HentaiNexusSettingsForm extends Form {
  override readonly requiresExplicitSubmission = false;

  override getSections(): FormSectionElement<unknown>[] {
    return [
      Section(
        {
          id: "images",
          header: "Images",
          footer:
            "AVIF pages are noticeably smaller, but the JPEG/PNG fallback is the safer choice if pages fail to render.",
        },
        [
          ToggleRow("useAvif", {
            title: "Prefer AVIF",
            value: usesAvif(),
            onValueChange: Application.Selector(this as HentaiNexusSettingsForm, "setUseAvif"),
          }),
        ],
      ),
      Section(
        {
          id: "titles",
          header: "Titles",
          footer:
            "Strips bracketed circle, artist and language annotations from titles. Reload a title to apply the change.",
        },
        [
          ToggleRow("shortenTitles", {
            title: "Shorten titles",
            value: shortensTitles(),
            onValueChange: Application.Selector(
              this as HentaiNexusSettingsForm,
              "setShortenTitles",
            ),
          }),
        ],
      ),
    ];
  }

  async setUseAvif(value: boolean): Promise<void> {
    Application.setState(value, PREF_USE_AVIF);
  }

  async setShortenTitles(value: boolean): Promise<void> {
    Application.setState(value, PREF_SHORTEN_TITLES);
  }
}
