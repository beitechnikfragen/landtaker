import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";

/**
 * Rank insignia for a given elo.
 *
 * The server stores elo, not a tier — the tiers here are a presentation layer
 * over that number, so a player sees "Gold II" rather than "1842". Thresholds
 * are deliberately in one place: change them here and every badge, label and
 * progress bar follows.
 *
 * Artwork lives in brand/ (see brand/LICENSE) as four tiers x three divisions.
 * The badge is decorative — the tier name always ships alongside it as text, so
 * the rank is never conveyed by image alone.
 */

export interface RankTier {
  /** Asset slug: bronze | silver | gold | platinum */
  readonly key: string;
  /** Display name, already capitalised */
  readonly name: string;
  /** Elo at which this tier starts */
  readonly floor: number;
}

/** Ascending. The last entry has no ceiling. */
export const RANK_TIERS: readonly RankTier[] = [
  { key: "bronze", name: "Bronze", floor: 0 },
  { key: "silver", name: "Silver", floor: 1200 },
  { key: "gold", name: "Gold", floor: 1600 },
  { key: "platinum", name: "Platinum", floor: 2000 },
] as const;

/** Each tier splits into three divisions, numbered I..III as elo rises. */
const DIVISIONS = 3;
/** Elo span above the top tier's floor that still maps into its divisions. */
const TOP_TIER_SPAN = 400;

export interface Rank {
  readonly tier: RankTier;
  /** 1-3 */
  readonly division: number;
  /** "Gold II" */
  readonly label: string;
  /** 0-1 progress through the current division */
  readonly progress: number;
  /** Elo still needed to reach the next division, or null at the very top */
  readonly toNext: number | null;
}

export function rankFromElo(elo: number): Rank {
  const index = RANK_TIERS.reduce(
    (acc, tier, i) => (elo >= tier.floor ? i : acc),
    0,
  );
  const tier = RANK_TIERS[index];
  const next = RANK_TIERS[index + 1];
  const span = (next ? next.floor - tier.floor : TOP_TIER_SPAN) / DIVISIONS;

  const stepsAbove = Math.floor((elo - tier.floor) / span);
  // The top tier has no ceiling, so clamp rather than run off the end.
  const division = Math.min(DIVISIONS, Math.max(1, stepsAbove + 1));

  const divisionFloor = tier.floor + (division - 1) * span;
  const withinDivision = (elo - divisionFloor) / span;
  const atCeiling = !next && division === DIVISIONS;

  return {
    tier,
    division,
    label: `${tier.name} ${"I".repeat(division)}`,
    progress: atCeiling ? 1 : Math.min(1, Math.max(0, withinDivision)),
    toNext: atCeiling
      ? null
      : Math.max(0, Math.ceil(divisionFloor + span - elo)),
  };
}

export function rankBadgeUrl(rank: Rank, small = false): string {
  return assetUrl(
    `images/ranks/${rank.tier.key}${rank.division}${small ? "@small" : ""}.webp`,
  );
}

/**
 * `<rank-badge elo="1842">` — insignia plus name, and optionally the progress
 * toward the next division.
 */
@customElement("rank-badge")
export class RankBadge extends LitElement {
  /** Player elo. Leave unset when the player has no ranked history. */
  @property({ type: Number }) elo: number | null = null;
  /** Badge edge length in px. Below ~34 the small asset is used. */
  @property({ type: Number }) size = 44;
  /** Show the tier name next to the badge. */
  @property({ type: Boolean }) showLabel = false;
  /** Show the division progress bar and the elo needed for the next one. */
  @property({ type: Boolean }) showProgress = false;

  createRenderRoot() {
    return this;
  }

  render() {
    if (this.elo === null || !Number.isFinite(this.elo)) return nothing;

    const rank = rankFromElo(this.elo);
    const src = rankBadgeUrl(rank, this.size <= 34);

    return html`
      <div class="flex items-center gap-3">
        <img
          src=${src}
          alt=""
          aria-hidden="true"
          width=${this.size}
          height=${this.size}
          class="block shrink-0"
          style="width:${this.size}px;height:${this.size}px"
        />
        ${this.showLabel || this.showProgress
          ? html`<div class="min-w-0 flex-1">
              ${this.showLabel
                ? html`<div class="lt-display text-[19px] leading-none">
                    ${rank.label}
                  </div>`
                : nothing}
              ${this.showProgress
                ? html`
                    <div class="lt-meter mt-2 mb-1.5">
                      <i style="width:${Math.round(rank.progress * 100)}%"></i>
                    </div>
                    <div class="lt-label !text-[12px] !text-lt-400">
                      ${rank.toNext === null
                        ? html`<span class="text-lt-accent">Max division</span>`
                        : html`<span class="text-lt-100">${rank.toNext}</span>
                            elo to next`}
                    </div>
                  `
                : nothing}
            </div>`
          : nothing}
      </div>
    `;
  }
}
