import type { TemplateResult } from "lit";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type {
  AdminAuditEntry,
  AdminUserDetail,
  AdminUserPatch,
  AdminUserSummary,
} from "../core/AdminApiSchemas";
import {
  adjustAdminCredits,
  banAdminUser,
  fetchAdminAudit,
  fetchAdminMe,
  fetchAdminUser,
  fetchAdminUsers,
  isAdminApiError,
  liftAdminBan,
  patchAdminUser,
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
      ${tab === "audit" ? this.renderAudit() : this.renderUsers()}
    `;
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
