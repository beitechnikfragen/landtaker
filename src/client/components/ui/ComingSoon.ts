import { html, type TemplateResult } from "lit";
import { translateText } from "../../Utils";

/**
 * PLACEHOLDER panel for nav entries whose feature is not built yet.
 *
 * The Clans and Store buttons stay visible on purpose — players should see
 * that these are planned — so opening one has to land on something honest
 * rather than a broken or empty screen. Remove the call site as soon as the
 * feature behind it works.
 */
export function renderComingSoon(): TemplateResult {
  return html`
    <div
      class="flex flex-col items-center justify-center gap-2 text-center p-12 min-h-[240px]"
    >
      <div
        class="text-lt-400 text-lg font-bold uppercase tracking-wider"
        data-testid="coming-soon-title"
      >
        ${translateText("common.coming_soon")}
      </div>
      <div class="text-lt-500 text-sm max-w-sm">
        ${translateText("common.coming_soon_description")}
      </div>
    </div>
  `;
}
