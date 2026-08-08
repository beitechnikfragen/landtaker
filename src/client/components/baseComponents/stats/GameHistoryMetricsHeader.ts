import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PublicPlayerGame } from "../../../../core/ApiSchemas";
import { getMapName, renderDuration, translateText } from "../../../Utils";
import {
  computeHistoryMetrics,
  type GameResult,
  type HistoryMetrics,
} from "./GameHistoryMetrics";

@customElement("game-history-metrics-header")
export class GameHistoryMetricsHeader extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) games: PublicPlayerGame[] = [];

  render(): TemplateResult {
    if (this.games.length === 0) return html``;
    const metrics = computeHistoryMetrics(this.games);
    return html`
      <div class="bg-white/5 border border-lt-700 p-4 space-y-3">
        <div
          class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 justify-items-center text-center"
        >
          ${this.renderTile(
            translateText("game_history.games"),
            `${metrics.totalGames}`,
          )}
          ${this.renderTile(
            translateText("game_history.win_rate"),
            metrics.winRate === null
              ? translateText("game_history.no_data")
              : `${Math.round(metrics.winRate * 100)}%`,
          )}
          ${this.renderTile(
            translateText("game_history.avg_duration"),
            metrics.avgDurationSeconds === null
              ? translateText("game_history.no_data")
              : renderDuration(Math.round(metrics.avgDurationSeconds)),
          )}
          ${this.renderTile(
            translateText("game_history.best_map"),
            metrics.bestMap === null
              ? translateText("game_history.no_data")
              : (getMapName(metrics.bestMap.map) ?? metrics.bestMap.map),
          )}
        </div>
        ${this.renderForm(metrics)}
        <p class="text-[11px] text-white/40 text-center">
          ${translateText("game_history.scope_note", {
            games: `${metrics.totalGames}`,
          })}
        </p>
      </div>
    `;
  }

  private renderTile(label: string, value: string): TemplateResult {
    return html`
      <div class="min-w-0">
        <div
          class="text-[10px] font-bold uppercase tracking-wider text-lt-500 mb-0.5"
        >
          ${label}
        </div>
        <div class="text-sm text-white truncate" title=${value}>${value}</div>
      </div>
    `;
  }

  private renderForm(metrics: HistoryMetrics): TemplateResult {
    if (metrics.form.length === 0) return html``;
    return html`
      <div class="flex items-center justify-center gap-2">
        <span
          class="text-[10px] font-bold uppercase tracking-wider text-lt-500"
        >
          ${translateText("game_history.form")}
        </span>
        <div class="flex gap-1">
          ${metrics.form.map((result) => this.renderFormDot(result))}
        </div>
      </div>
    `;
  }

  private renderFormDot(result: GameResult): TemplateResult {
    const tint =
      result === "victory"
        ? "bg-green-600"
        : result === "defeat"
          ? "bg-lt-bad"
          : "bg-gray-500";
    const label =
      result === "victory"
        ? translateText("clan_modal.history_result_victory")
        : result === "defeat"
          ? translateText("clan_modal.history_result_defeat")
          : translateText("account_modal.games_result_incomplete");
    return html`<span
      class="inline-block w-2.5 h-2.5 rounded-full ${tint}"
      title=${label}
      aria-label=${label}
      role="img"
    ></span>`;
  }
}
