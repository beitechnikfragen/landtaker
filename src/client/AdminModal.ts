import type { TemplateResult } from "lit";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type {
  AdminAuditEntry,
  AdminFeedback,
  AdminUserDetail,
  AdminUserPatch,
  AdminUserSummary,
} from "../core/AdminApiSchemas";
import {
  type AdminCosmetic,
  type AdminShopConfig,
  adjustAdminCredits,
  banAdminUser,
  deleteAdminCosmetic,
  deleteAdminFeedback,
  fetchAdminAudit,
  fetchAdminCosmetics,
  fetchAdminFeedback,
  fetchAdminMe,
  fetchAdminRotation,
  fetchAdminShopConfig,
  fetchAdminUser,
  fetchAdminUsers,
  isAdminApiError,
  liftAdminBan,
  patchAdminUser,
  saveAdminCosmetic,
  saveAdminShopConfig,
  setAdminFeedbackStatus,
} from "./AdminApi";
import { BaseModal } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";
import { translateText } from "./Utils";

const PAGE_SIZE = 25;

/** Roles the panel offers. Root is absent — the backend refuses it anyway. */
const ROLE_OPTIONS = ["admin", "mod", "flagged", "banned"] as const;

/**
 * Admin panel.
 *
 * Gated twice: the nav entry only appears for admins, and every request is
 * re-authorized server-side against the database role. The client gate is
 * cosmetic — it decides what to render, never what is permitted.
 *
 * `isRoot` drives which controls are enabled rather than which are visible: an
 * admin who cannot grant admin should see that the control exists and is
 * reserved, not be confused about where it went.
 */
@customElement("admin-modal")
export class AdminModal extends BaseModal {
  protected routerName = "admin";

  @state() private authorized: boolean | null = null;
  @state() private isRoot = false;

  // Users tab
  @state() private query = "";
  @state() private roleFilter = "";
  @state() private page = 0;
  @state() private users: AdminUserSummary[] = [];
  @state() private total = 0;
  @state() private loadingUsers = false;

  // Detail pane
  @state() private selected: AdminUserDetail | null = null;
  @state() private loadingDetail = false;
  @state() private saving = false;

  // Audit tab
  @state() private audit: AdminAuditEntry[] = [];
  @state() private loadingAudit = false;

  // Shop tab
  @state() private shopCosmetics: AdminCosmetic[] = [];
  @state() private shopConfig: AdminShopConfig | null = null;
  @state() private rotation: {
    startsAt: string;
    endsAt: string;
    cosmeticIds: string[];
  } | null = null;
  @state() private loadingShop = false;
  @state() private newCosmetic = {
    kind: "flag",
    name: "",
    displayName: "",
    priceSoft: "",
    priceHard: "",
    payload: "",
  };

  // Feedback tab
  @state() private feedback: AdminFeedback[] = [];
  @state() private feedbackCounts: Record<string, number> = {};
  @state() private feedbackFilter: string = "new";
  @state() private loadingFeedback = false;

  @state() private error: string | null = null;
  @state() private notice: string | null = null;

  // Draft form state for the detail pane. Held on the component rather than in
  // render-local variables: renderBody runs again on every state change (a save
  // completing, a banner appearing), and locals would silently reset a
  // half-typed reason or flare list underneath the operator.
  @state() private creditDelta = "";
  @state() private creditReason = "";
  @state() private flareDraft = "";
  @state() private banCategory = "";
  @state() private banReason = "";
  @state() private banHours = "";

  protected modalConfig() {
    return {
      title: translateText("admin.title"),
      maxWidth: "1200px",
      tabs: [
        { key: "users", label: translateText("admin.tab_users") },
        { key: "shop", label: translateText("admin.tab_shop") },
        { key: "feedback", label: translateText("admin.tab_feedback") },
        { key: "audit", label: translateText("admin.tab_audit") },
      ],
    };
  }

  protected onOpen(): void {
    this.error = null;
    this.notice = null;
    void this.checkAuthorization();
  }

  protected onTabEnter(key: string): void {
    if (this.authorized !== true) return;
    if (key === "users" && this.users.length === 0) void this.loadUsers();
    if (key === "audit") void this.loadAudit();
    if (key === "shop") void this.loadShop();
    if (key === "feedback") void this.loadFeedback();
  }

  private async checkAuthorization(): Promise<void> {
    const me = await fetchAdminMe();
    this.authorized = me !== false;
    this.isRoot = me !== false && me.isRoot;
    if (this.authorized) void this.loadUsers();
  }

  // ---- Data loading ----

  private async loadUsers(): Promise<void> {
    this.loadingUsers = true;
    this.error = null;
    const result = await fetchAdminUsers({
      q: this.query || undefined,
      role: this.roleFilter || undefined,
      limit: PAGE_SIZE,
      offset: this.page * PAGE_SIZE,
    });
    this.loadingUsers = false;

    if (isAdminApiError(result)) {
      this.error = result.error;
      return;
    }
    this.users = result.users;
    this.total = result.total;
  }

  private async loadAudit(): Promise<void> {
    this.loadingAudit = true;
    const result = await fetchAdminAudit({ limit: 100 });
    this.loadingAudit = false;
    if (isAdminApiError(result)) {
      this.error = result.error;
      return;
    }
    this.audit = result.entries;
  }

  private async loadShop(): Promise<void> {
    this.loadingShop = true;
    const [items, config, rotation] = await Promise.all([
      fetchAdminCosmetics(),
      fetchAdminShopConfig(),
      fetchAdminRotation(),
    ]);
    this.loadingShop = false;

    // Report the first failure rather than silently rendering partial state.
    for (const result of [items, config, rotation]) {
      if (isAdminApiError(result)) {
        this.error = result.error;
        return;
      }
    }
    this.shopCosmetics = items as AdminCosmetic[];
    this.shopConfig = config as AdminShopConfig;
    this.rotation = rotation as {
      startsAt: string;
      endsAt: string;
      cosmeticIds: string[];
    };
  }

  private async loadFeedback(): Promise<void> {
    this.loadingFeedback = true;
    const result = await fetchAdminFeedback({
      // "all" is a UI-only value; the API takes an absent status to mean the
      // same thing, so it is dropped rather than sent.
      status: this.feedbackFilter === "all" ? undefined : this.feedbackFilter,
      limit: 100,
    });
    this.loadingFeedback = false;
    if (isAdminApiError(result)) {
      this.error = result.error;
      return;
    }
    this.feedback = result.reports;
    this.feedbackCounts = result.counts;
  }

  private async selectUser(id: string): Promise<void> {
    this.loadingDetail = true;
    this.error = null;
    this.notice = null;
    const result = await fetchAdminUser(id);
    this.loadingDetail = false;
    if (isAdminApiError(result)) {
      this.error = result.error;
      return;
    }
    this.selected = result;
    this.resetDrafts(result);
  }

  /** Clears per-user form drafts so one account's input never leaks onto another. */
  private resetDrafts(user: AdminUserDetail): void {
    this.flareDraft = user.flares.join("\n");
    this.creditDelta = "";
    this.creditReason = "";
    this.banCategory = "";
    this.banReason = "";
    this.banHours = "";
  }

  /**
   * Applies a mutation and folds the result back into both panes. Every
   * mutating call goes through here so the list row and the detail pane can
   * never disagree about an account's state.
   */
  private async mutate(
    run: () => Promise<AdminUserDetail | { error: string }>,
    successMessage: string,
  ): Promise<void> {
    this.saving = true;
    this.error = null;
    this.notice = null;
    const result = await run();
    this.saving = false;

    if (isAdminApiError(result)) {
      this.error = result.error;
      return;
    }
    this.selected = result;
    this.resetDrafts(result);
    this.notice = successMessage;
    this.users = this.users.map((row) =>
      row.id === result.id
        ? {
            ...row,
            role: result.role,
            credits: result.credits,
            adfree: result.adfree,
            unlimitedRanked: result.unlimitedRanked,
            canCreatePublicLobbies: result.canCreatePublicLobbies,
            flareCount: result.flares.length,
            banned: result.banned,
          }
        : row,
    );
  }

  private savePatch(patch: AdminUserPatch): void {
    const id = this.selected?.id;
    if (!id) return;
    void this.mutate(
      () => patchAdminUser(id, patch),
      translateText("admin.saved"),
    );
  }

  private async grantCredits(delta: number, reason: string): Promise<void> {
    const id = this.selected?.id;
    if (!id) return;
    this.saving = true;
    this.error = null;
    const result = await adjustAdminCredits(id, delta, reason);
    this.saving = false;
    if (isAdminApiError(result)) {
      this.error = result.error;
      return;
    }
    // The credits endpoint returns only the new balance; re-read the account so
    // the detail pane and the row stay consistent with everything else.
    await this.selectUser(id);
    this.users = this.users.map((row) =>
      row.id === id ? { ...row, credits: result.credits } : row,
    );
    this.notice = translateText("admin.credits_updated");
  }

  // ---- Rendering ----

  private header(): TemplateResult {
    return modalHeader({
      title: translateText("admin.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody(tab: string): TemplateResult {
    if (this.authorized === null) {
      return html`${this.header()} ${this.renderLoadingSpinner()}`;
    }
    if (this.authorized === false) {
      return html`
        ${this.header()}
        <div class="p-8 text-center text-lt-400">
          ${translateText("admin.not_authorized")}
        </div>
      `;
    }

    return html`
      ${this.header()} ${this.renderBanner()}
      ${tab === "audit"
        ? this.renderAudit()
        : tab === "shop"
          ? this.renderShop()
          : tab === "feedback"
            ? this.renderFeedback()
            : this.renderUsers()}
    `;
  }

  // ---- Feedback tab ----

  private renderFeedback(): TemplateResult {
    const filters = ["new", "triaged", "resolved", "rejected", "all"];
    return html`
      <div class="p-4">
        <div class="mb-3 flex flex-wrap gap-1">
          ${filters.map((key) => {
            const active = this.feedbackFilter === key;
            const n = key === "all" ? undefined : this.feedbackCounts[key];
            return html`
              <button
                class="rounded border px-3 py-1 text-xs ${active
                  ? "border-blue-500 bg-blue-600 text-white"
                  : "border-lt-600 text-lt-300 hover:bg-lt-800"}"
                @click=${() => {
                  this.feedbackFilter = key;
                  void this.loadFeedback();
                }}
              >
                ${translateText(`admin.feedback_${key}`)}${n !== undefined
                  ? ` (${n})`
                  : ""}
              </button>
            `;
          })}
        </div>
        ${this.loadingFeedback
          ? this.renderLoadingSpinner()
          : this.feedback.length === 0
            ? html`<div
                class="rounded border border-lt-600 p-8 text-center text-lt-400"
              >
                ${translateText("admin.no_feedback")}
              </div>`
            : html`<div class="flex flex-col gap-2">
                ${this.feedback.map((report) => this.renderReport(report))}
              </div>`}
      </div>
    `;
  }

  private renderReport(report: AdminFeedback): TemplateResult {
    const setStatus = async (status: string) => {
      const result = await setAdminFeedbackStatus(
        report.id,
        status as Parameters<typeof setAdminFeedbackStatus>[1],
      );
      if (isAdminApiError(result)) this.error = result.error;
      else void this.loadFeedback();
    };

    const typeColor =
      report.type === "bug"
        ? "bg-red-900/60 text-red-300"
        : report.type === "idea"
          ? "bg-blue-900/60 text-blue-300"
          : "bg-lt-700 text-lt-300";

    return html`
      <div class="rounded border border-lt-600 p-3 text-white">
        <div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span class="rounded px-2 py-0.5 uppercase ${typeColor}"
            >${report.type}</span
          >
          <span class="text-lt-400">
            ${report.username ??
            report.contactEmail ??
            translateText("admin.feedback_guest")}
          </span>
          <span class="text-lt-500"
            >${new Date(report.createdAt).toLocaleString()}</span
          >
          <span class="ml-auto text-lt-500">${report.status}</span>
        </div>

        <!-- Player-submitted text. Interpolated as a Lit text binding, which
             escapes it — never unsafeHTML, or a report could inject markup
             into the panel. -->
        <p class="mb-2 whitespace-pre-wrap break-words text-sm">
          ${report.message}
        </p>

        ${report.context
          ? html`<details class="mb-2">
              <summary class="cursor-pointer text-xs text-lt-400">
                ${translateText("admin.feedback_context")}
              </summary>
              <pre
                class="mt-1 overflow-x-auto rounded bg-lt-800 p-2 font-mono text-[10px] text-lt-300"
              >
${JSON.stringify(report.context, null, 2)}</pre
              >
            </details>`
          : null}

        <div class="flex flex-wrap gap-1">
          ${["triaged", "resolved", "rejected"]
            .filter((s) => s !== report.status)
            .map(
              (s) => html`
                <button
                  class="rounded border border-lt-600 px-2 py-0.5 text-xs hover:bg-lt-700"
                  @click=${() => void setStatus(s)}
                >
                  ${translateText(`admin.feedback_mark_${s}`)}
                </button>
              `,
            )}
          <button
            class="ml-auto rounded border border-red-700 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900/40"
            title=${translateText("admin.feedback_delete_hint")}
            @click=${async () => {
              const result = await deleteAdminFeedback(report.id);
              if (isAdminApiError(result)) this.error = result.error;
              else void this.loadFeedback();
            }}
          >
            ${translateText("admin.delete")}
          </button>
        </div>
      </div>
    `;
  }

  // ---- Shop tab ----

  private renderShop(): TemplateResult {
    if (this.loadingShop) return this.renderLoadingSpinner();
    return html`
      <div class="flex flex-col gap-4 p-4">
        ${this.renderRotationPanel()} ${this.renderCosmeticsTable()}
        ${this.renderNewCosmeticForm()}
      </div>
    `;
  }

  private renderRotationPanel(): TemplateResult {
    const config = this.shopConfig;
    const rotation = this.rotation;
    return html`
      <div class="rounded border border-lt-600 p-4 text-white">
        <div class="mb-3 text-sm font-semibold">
          ${translateText("admin.drop_settings")}
        </div>
        <div class="mb-3 flex flex-wrap items-end gap-3">
          <label class="text-xs text-lt-400">
            ${translateText("admin.rotation_hours")}
            <input
              type="number"
              min="1"
              class="mt-1 block w-24 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm text-white"
              .value=${String(config?.rotationHours ?? 6)}
              @input=${(e: Event) => {
                const value = Number((e.target as HTMLInputElement).value);
                if (this.shopConfig) this.shopConfig.rotationHours = value;
              }}
            />
          </label>
          <label class="text-xs text-lt-400">
            ${translateText("admin.items_per_drop")}
            <input
              type="number"
              min="1"
              class="mt-1 block w-24 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm text-white"
              .value=${String(config?.itemsPerRotation ?? 4)}
              @input=${(e: Event) => {
                const value = Number((e.target as HTMLInputElement).value);
                if (this.shopConfig) this.shopConfig.itemsPerRotation = value;
              }}
            />
          </label>
          <button
            class="rounded bg-blue-600 px-4 py-1.5 text-sm hover:bg-blue-500"
            @click=${async () => {
              if (!this.shopConfig) return;
              const result = await saveAdminShopConfig(this.shopConfig);
              if (isAdminApiError(result)) this.error = result.error;
              else this.notice = translateText("admin.saved");
            }}
          >
            ${translateText("admin.apply")}
          </button>
        </div>
        <p class="mb-2 text-xs text-lt-500">
          ${translateText("admin.rotation_takes_effect")}
        </p>
        ${rotation
          ? html`<div class="text-xs text-lt-400">
              ${translateText("admin.current_drop")}:
              ${new Date(rotation.startsAt).toLocaleString()} —
              ${new Date(rotation.endsAt).toLocaleString()}
              (${rotation.cosmeticIds.length} ${translateText("admin.items")})
            </div>`
          : null}
      </div>
    `;
  }

  private renderCosmeticsTable(): TemplateResult {
    if (this.shopCosmetics.length === 0) {
      return html`<div
        class="rounded border border-lt-600 p-6 text-center text-lt-400"
      >
        ${translateText("admin.no_cosmetics")}
      </div>`;
    }
    const inDrop = new Set(this.rotation?.cosmeticIds ?? []);

    return html`
      <div class="overflow-x-auto rounded border border-lt-600">
        <table class="w-full text-left text-sm text-white">
          <thead class="bg-lt-800 text-lt-300">
            <tr>
              <th class="px-3 py-2">${translateText("admin.col_kind")}</th>
              <th class="px-3 py-2">${translateText("admin.col_name")}</th>
              <th class="px-3 py-2">${translateText("admin.col_soft")}</th>
              <th class="px-3 py-2">${translateText("admin.col_hard")}</th>
              <th class="px-3 py-2">${translateText("admin.col_live")}</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            ${this.shopCosmetics.map(
              (item) => html`
                <tr class="border-t border-lt-700">
                  <td class="px-3 py-2 text-lt-400">${item.kind}</td>
                  <td class="px-3 py-2">
                    ${item.displayName ?? item.name}
                    ${inDrop.has(item.id)
                      ? html`<span
                          class="ml-2 rounded bg-green-700 px-1.5 py-0.5 text-[10px] uppercase"
                          >${translateText("admin.in_drop")}</span
                        >`
                      : null}
                  </td>
                  <td class="px-3 py-2">${item.priceSoft ?? "—"}</td>
                  <td class="px-3 py-2">${item.priceHard ?? "—"}</td>
                  <td class="px-3 py-2">
                    <input
                      type="checkbox"
                      .checked=${item.published}
                      @change=${async (e: Event) => {
                        const published = (e.target as HTMLInputElement)
                          .checked;
                        const result = await saveAdminCosmetic({
                          ...item,
                          payload: (item.payload ?? {}) as Record<
                            string,
                            unknown
                          >,
                          published,
                        });
                        if (isAdminApiError(result)) this.error = result.error;
                        else void this.loadShop();
                      }}
                    />
                  </td>
                  <td class="px-3 py-2 text-right">
                    <button
                      class="rounded border border-lt-600 px-2 py-0.5 text-xs hover:bg-lt-700"
                      @click=${async () => {
                        const result = await deleteAdminCosmetic(
                          item.kind,
                          item.name,
                        );
                        if (isAdminApiError(result)) this.error = result.error;
                        else void this.loadShop();
                      }}
                    >
                      ${translateText("admin.delete")}
                    </button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderNewCosmeticForm(): TemplateResult {
    const draft = this.newCosmetic;
    const set = (key: keyof typeof draft) => (e: Event) => {
      this.newCosmetic = {
        ...this.newCosmetic,
        [key]: (e.target as HTMLInputElement).value,
      };
    };

    return html`
      <div class="rounded border border-lt-600 p-4 text-white">
        <div class="mb-3 text-sm font-semibold">
          ${translateText("admin.add_cosmetic")}
        </div>
        <div class="flex flex-wrap gap-2">
          <select
            class="rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm"
            .value=${draft.kind}
            @change=${set("kind")}
          >
            ${["pattern", "flag", "crown", "skin", "effect"].map(
              (kind) => html`<option value=${kind}>${kind}</option>`,
            )}
          </select>
          <input
            class="w-40 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm"
            placeholder=${translateText("admin.col_name")}
            .value=${draft.name}
            @input=${set("name")}
          />
          <input
            type="number"
            class="w-28 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm"
            placeholder=${translateText("admin.col_soft")}
            .value=${draft.priceSoft}
            @input=${set("priceSoft")}
          />
          <input
            type="number"
            class="w-28 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm"
            placeholder=${translateText("admin.col_hard")}
            .value=${draft.priceHard}
            @input=${set("priceHard")}
          />
        </div>
        <textarea
          class="mt-2 h-20 w-full rounded border border-lt-600 bg-lt-800 px-2 py-1 font-mono text-xs"
          placeholder=${translateText("admin.payload_hint")}
          .value=${draft.payload}
          @input=${set("payload")}
        ></textarea>
        <button
          class="mt-2 rounded bg-blue-600 px-4 py-1.5 text-sm hover:bg-blue-500"
          @click=${() => void this.addCosmetic()}
        >
          ${translateText("admin.add")}
        </button>
      </div>
    `;
  }

  private async addCosmetic(): Promise<void> {
    const draft = this.newCosmetic;
    if (!draft.name.trim()) {
      this.error = translateText("admin.cosmetic_need_name");
      return;
    }

    // The payload is kind-specific (a flag's url, an effect's attributes), so
    // it is entered as raw JSON. Parse here rather than sending a string the
    // server would have to guess about.
    let payload: Record<string, unknown> = {};
    if (draft.payload.trim()) {
      try {
        payload = JSON.parse(draft.payload);
      } catch {
        this.error = translateText("admin.payload_invalid");
        return;
      }
    }

    const result = await saveAdminCosmetic({
      kind: draft.kind,
      name: draft.name.trim(),
      displayName: draft.displayName.trim() || null,
      priceSoft: draft.priceSoft ? Number(draft.priceSoft) : null,
      priceHard: draft.priceHard ? Number(draft.priceHard) : null,
      payload,
      published: false,
    });
    if (isAdminApiError(result)) {
      this.error = result.error;
      return;
    }
    this.newCosmetic = {
      kind: draft.kind,
      name: "",
      displayName: "",
      priceSoft: "",
      priceHard: "",
      payload: "",
    };
    this.notice = translateText("admin.saved");
    void this.loadShop();
  }

  private renderBanner(): TemplateResult | null {
    if (this.error) {
      return html`<div
        class="mx-4 mb-3 rounded border border-red-500/40 bg-red-500/10 px-4 py-2 text-red-300"
      >
        ${this.error}
      </div>`;
    }
    if (this.notice) {
      return html`<div
        class="mx-4 mb-3 rounded border border-green-500/40 bg-green-500/10 px-4 py-2 text-green-300"
      >
        ${this.notice}
      </div>`;
    }
    return null;
  }

  private renderUsers(): TemplateResult {
    return html`
      <div class="flex flex-col gap-4 p-4 lg:flex-row">
        <div class="lg:w-1/2">
          ${this.renderSearch()} ${this.renderUserTable()}
        </div>
        <div class="lg:w-1/2">
          ${this.selected
            ? this.renderDetail(this.selected)
            : html`<div
                class="rounded border border-lt-600 p-8 text-center text-lt-400"
              >
                ${translateText("admin.select_a_user")}
              </div>`}
        </div>
      </div>
    `;
  }

  private renderSearch(): TemplateResult {
    const submit = (e: Event) => {
      e.preventDefault();
      this.page = 0;
      void this.loadUsers();
    };
    return html`
      <form class="mb-3 flex flex-wrap gap-2" @submit=${submit}>
        <input
          class="flex-1 rounded border border-lt-600 bg-lt-800 px-3 py-2 text-white"
          .value=${this.query}
          placeholder=${translateText("admin.search_placeholder")}
          @input=${(e: Event) => {
            this.query = (e.target as HTMLInputElement).value;
          }}
        />
        <select
          class="rounded border border-lt-600 bg-lt-800 px-3 py-2 text-white"
          .value=${this.roleFilter}
          @change=${(e: Event) => {
            this.roleFilter = (e.target as HTMLSelectElement).value;
            this.page = 0;
            void this.loadUsers();
          }}
        >
          <option value="">${translateText("admin.role_any")}</option>
          <option value="none">${translateText("admin.role_none")}</option>
          <option value="root">root</option>
          ${ROLE_OPTIONS.map(
            (role) => html`<option value=${role}>${role}</option>`,
          )}
        </select>
        <button
          type="submit"
          class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
        >
          ${translateText("admin.search")}
        </button>
      </form>
    `;
  }

  private renderUserTable(): TemplateResult {
    if (this.loadingUsers) return this.renderLoadingSpinner();
    if (this.users.length === 0) {
      return html`<div
        class="rounded border border-lt-600 p-8 text-center text-lt-400"
      >
        ${translateText("admin.no_users")}
      </div>`;
    }

    const pages = Math.ceil(this.total / PAGE_SIZE);
    return html`
      <div class="overflow-x-auto rounded border border-lt-600">
        <table class="w-full text-left text-sm text-white">
          <thead class="bg-lt-800 text-lt-300">
            <tr>
              <th class="px-3 py-2">${translateText("admin.col_user")}</th>
              <th class="px-3 py-2">${translateText("admin.col_role")}</th>
              <th class="px-3 py-2">${translateText("admin.col_credits")}</th>
              <th class="px-3 py-2">${translateText("admin.col_status")}</th>
            </tr>
          </thead>
          <tbody>
            ${this.users.map(
              (user) => html`
                <tr
                  class="cursor-pointer border-t border-lt-700 hover:bg-lt-800 ${this
                    .selected?.id === user.id
                    ? "bg-lt-800"
                    : ""}"
                  @click=${() => void this.selectUser(user.id)}
                >
                  <td class="px-3 py-2">
                    <div>${user.username ?? user.publicId}</div>
                    <div class="text-xs text-lt-400">${user.email ?? ""}</div>
                  </td>
                  <td class="px-3 py-2">${user.role ?? "—"}</td>
                  <td class="px-3 py-2">${user.credits}</td>
                  <td class="px-3 py-2">
                    ${user.banned
                      ? html`<span class="text-red-400"
                          >${translateText("admin.banned")}</span
                        >`
                      : html`<span class="text-lt-400">—</span>`}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      ${pages > 1
        ? html`
            <div
              class="mt-2 flex items-center justify-between text-sm text-lt-300"
            >
              <button
                class="rounded border border-lt-600 px-3 py-1 disabled:opacity-40"
                ?disabled=${this.page === 0}
                @click=${() => {
                  this.page--;
                  void this.loadUsers();
                }}
              >
                ${translateText("admin.prev")}
              </button>
              <span>${this.page + 1} / ${pages}</span>
              <button
                class="rounded border border-lt-600 px-3 py-1 disabled:opacity-40"
                ?disabled=${this.page >= pages - 1}
                @click=${() => {
                  this.page++;
                  void this.loadUsers();
                }}
              >
                ${translateText("admin.next")}
              </button>
            </div>
          `
        : null}
    `;
  }

  private renderDetail(user: AdminUserDetail): TemplateResult {
    if (this.loadingDetail) return this.renderLoadingSpinner();

    // Mirrors the server-side ladder so the panel does not offer an action it
    // knows will be refused. The server checks again regardless.
    const targetIsPrivileged = user.role === "root" || user.role === "admin";
    const mayEditRole = this.isRoot || !targetIsPrivileged;

    return html`
      <div class="rounded border border-lt-600 p-4 text-white">
        <div class="mb-4">
          <div class="text-lg font-semibold">
            ${user.username ?? user.publicId}
          </div>
          <div class="text-xs text-lt-400">${user.id}</div>
        </div>

        ${this.renderRoleControl(user, mayEditRole)} ${this.renderToggles(user)}
        ${this.renderCredits(user)} ${this.renderFlares(user)}
        ${this.renderBans(user)}
      </div>
    `;
  }

  private renderRoleControl(
    user: AdminUserDetail,
    mayEdit: boolean,
  ): TemplateResult {
    return html`
      <div class="mb-4">
        <label class="mb-1 block text-sm text-lt-300"
          >${translateText("admin.role")}</label
        >
        <select
          class="w-full rounded border border-lt-600 bg-lt-800 px-3 py-2 text-white disabled:opacity-50"
          ?disabled=${!mayEdit || this.saving}
          .value=${user.role ?? ""}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            this.savePatch({
              role: value === "" ? null : (value as AdminUserPatch["role"]),
            });
          }}
        >
          <option value="">${translateText("admin.role_none")}</option>
          ${ROLE_OPTIONS.map(
            (role) => html`<option value=${role}>${role}</option>`,
          )}
          ${user.role === "root"
            ? html`<option value="root" disabled selected>root</option>`
            : null}
        </select>
        ${!mayEdit
          ? html`<p class="mt-1 text-xs text-lt-400">
              ${translateText("admin.role_root_only")}
            </p>`
          : null}
      </div>
    `;
  }

  private renderToggles(user: AdminUserDetail): TemplateResult {
    const toggle = (
      label: string,
      value: boolean,
      key: keyof AdminUserPatch,
    ) => html`
      <label class="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          .checked=${value}
          ?disabled=${this.saving}
          @change=${(e: Event) => {
            this.savePatch({
              [key]: (e.target as HTMLInputElement).checked,
            } as AdminUserPatch);
          }}
        />
        ${label}
      </label>
    `;

    return html`
      <div class="mb-4 flex flex-col gap-2">
        ${toggle(translateText("admin.adfree"), user.adfree, "adfree")}
        ${toggle(
          translateText("admin.unlimited_ranked"),
          user.unlimitedRanked,
          "unlimitedRanked",
        )}
        ${toggle(
          translateText("admin.public_lobbies"),
          user.canCreatePublicLobbies,
          "canCreatePublicLobbies",
        )}
      </div>
    `;
  }

  private renderCredits(user: AdminUserDetail): TemplateResult {
    return html`
      <div class="mb-4">
        <label class="mb-1 block text-sm text-lt-300">
          ${translateText("admin.credits")}: ${user.credits}
        </label>
        <div class="flex gap-2">
          <input
            type="number"
            class="w-28 rounded border border-lt-600 bg-lt-800 px-3 py-2 text-white"
            placeholder="±0"
            .value=${this.creditDelta}
            @input=${(e: Event) => {
              this.creditDelta = (e.target as HTMLInputElement).value;
            }}
          />
          <input
            class="flex-1 rounded border border-lt-600 bg-lt-800 px-3 py-2 text-white"
            placeholder=${translateText("admin.reason")}
            .value=${this.creditReason}
            @input=${(e: Event) => {
              this.creditReason = (e.target as HTMLInputElement).value;
            }}
          />
          <button
            class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 disabled:opacity-40"
            ?disabled=${this.saving}
            @click=${() => {
              const delta = Number(this.creditDelta);
              // A reason is required by the API and is the whole point of the
              // audit entry, so refuse locally rather than round-trip a 400.
              if (!Number.isInteger(delta) || delta === 0) {
                this.error = translateText("admin.credits_need_amount");
                return;
              }
              if (!this.creditReason.trim()) {
                this.error = translateText("admin.credits_need_reason");
                return;
              }
              void this.grantCredits(delta, this.creditReason.trim());
            }}
          >
            ${translateText("admin.apply")}
          </button>
        </div>
      </div>
    `;
  }

  private renderFlares(user: AdminUserDetail): TemplateResult {
    // Flares are entitlement strings ("pattern:x", "flag:de"), one per line.
    // Edited as raw text because the cosmetics catalog that would populate a
    // picker does not exist yet; the shop phase replaces this with a chooser.
    return html`
      <div class="mb-4">
        <label class="mb-1 block text-sm text-lt-300">
          ${translateText("admin.flares")} (${user.flares.length})
        </label>
        <textarea
          class="h-24 w-full rounded border border-lt-600 bg-lt-800 px-3 py-2 font-mono text-xs text-white"
          .value=${this.flareDraft}
          @input=${(e: Event) => {
            this.flareDraft = (e.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <button
          class="mt-1 rounded bg-blue-600 px-4 py-1 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
          ?disabled=${this.saving}
          @click=${() => {
            this.savePatch({
              flares: this.flareDraft
                .split("\n")
                .map((f) => f.trim())
                .filter((f) => f !== ""),
            });
          }}
        >
          ${translateText("admin.save_flares")}
        </button>
      </div>
    `;
  }

  private renderBans(user: AdminUserDetail): TemplateResult {
    return html`
      <div>
        <label class="mb-1 block text-sm text-lt-300"
          >${translateText("admin.bans")}</label
        >
        ${user.bans.length === 0
          ? html`<p class="mb-2 text-xs text-lt-400">
              ${translateText("admin.no_bans")}
            </p>`
          : html`
              <ul class="mb-2 flex flex-col gap-1">
                ${user.bans.map(
                  (ban) => html`
                    <li
                      class="flex items-center justify-between rounded border border-lt-700 px-2 py-1 text-xs"
                    >
                      <span
                        class=${ban.liftedAt ? "text-lt-500 line-through" : ""}
                      >
                        ${ban.category}${ban.reason ? ` — ${ban.reason}` : ""}
                        ${ban.expiresAt
                          ? ` (${new Date(ban.expiresAt).toLocaleDateString()})`
                          : ` (${translateText("admin.permanent")})`}
                      </span>
                      ${ban.liftedAt
                        ? null
                        : html`<button
                            class="rounded border border-lt-600 px-2 py-0.5 hover:bg-lt-700"
                            ?disabled=${this.saving}
                            @click=${() =>
                              void this.mutate(
                                () => liftAdminBan(user.id, ban.id),
                                translateText("admin.ban_lifted"),
                              )}
                          >
                            ${translateText("admin.lift")}
                          </button>`}
                    </li>
                  `,
                )}
              </ul>
            `}
        <div class="flex flex-wrap gap-2">
          <input
            class="w-32 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm text-white"
            placeholder=${translateText("admin.ban_category")}
            .value=${this.banCategory}
            @input=${(e: Event) => {
              this.banCategory = (e.target as HTMLInputElement).value;
            }}
          />
          <input
            class="flex-1 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm text-white"
            placeholder=${translateText("admin.reason")}
            .value=${this.banReason}
            @input=${(e: Event) => {
              this.banReason = (e.target as HTMLInputElement).value;
            }}
          />
          <input
            type="number"
            class="w-24 rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm text-white"
            placeholder=${translateText("admin.ban_hours")}
            .value=${this.banHours}
            @input=${(e: Event) => {
              this.banHours = (e.target as HTMLInputElement).value;
            }}
          />
          <button
            class="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-500 disabled:opacity-40"
            ?disabled=${this.saving}
            @click=${() => {
              if (!this.banCategory.trim()) {
                this.error = translateText("admin.ban_need_category");
                return;
              }
              // Empty means permanent. A non-positive number would be rejected
              // by the schema, so treat it the same way rather than 400ing.
              const hours = this.banHours ? Number(this.banHours) : null;
              void this.mutate(
                () =>
                  banAdminUser(user.id, {
                    category: this.banCategory.trim(),
                    reason: this.banReason.trim() || undefined,
                    durationHours: hours && hours > 0 ? hours : null,
                  }),
                translateText("admin.ban_created"),
              );
            }}
          >
            ${translateText("admin.ban")}
          </button>
        </div>
      </div>
    `;
  }

  private renderAudit(): TemplateResult {
    if (this.loadingAudit) return this.renderLoadingSpinner();
    if (this.audit.length === 0) {
      return html`<div class="p-8 text-center text-lt-400">
        ${translateText("admin.no_audit")}
      </div>`;
    }
    return html`
      <div class="overflow-x-auto p-4">
        <table class="w-full text-left text-sm text-white">
          <thead class="bg-lt-800 text-lt-300">
            <tr>
              <th class="px-3 py-2">${translateText("admin.col_when")}</th>
              <th class="px-3 py-2">${translateText("admin.col_actor")}</th>
              <th class="px-3 py-2">${translateText("admin.col_action")}</th>
              <th class="px-3 py-2">${translateText("admin.col_detail")}</th>
            </tr>
          </thead>
          <tbody>
            ${this.audit.map(
              (entry) => html`
                <tr class="border-t border-lt-700 align-top">
                  <td class="whitespace-nowrap px-3 py-2 text-xs text-lt-400">
                    ${new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td class="px-3 py-2">${entry.actorName ?? "—"}</td>
                  <td class="px-3 py-2 font-mono text-xs">${entry.action}</td>
                  <td class="px-3 py-2 font-mono text-xs text-lt-400">
                    ${JSON.stringify(entry.detail)}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }
}
