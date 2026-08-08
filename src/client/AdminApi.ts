import {
  type AdminAuditListResponse,
  AdminAuditListResponseSchema,
  type AdminBanCreate,
  type AdminUserDetail,
  AdminUserDetailSchema,
  type AdminUserListResponse,
  AdminUserListResponseSchema,
  type AdminUserPatch,
} from "../core/AdminApiSchemas";
import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";

/**
 * Client for the /admin/* routes. Follows ClanApi's shape: one authenticated
 * fetch helper, one function per endpoint, Zod-validated responses.
 *
 * Every call here 404s for non-admins — the backend deliberately does not
 * distinguish "not an admin" from "no such route" (see requireAdmin). The
 * panel therefore treats a 404 on /admin/me as "you are not an admin" rather
 * than as an error worth showing.
 */

export type AdminApiError = { error: string };

function isError<T>(value: T | AdminApiError): value is AdminApiError {
  return typeof value === "object" && value !== null && "error" in value;
}
export { isError as isAdminApiError };

async function adminFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options?.headers,
      Authorization: await getAuthHeader(),
    },
  });
}

/**
 * Reads an error body without assuming one is there. The backend answers 4xx
 * with `{error}`, but a proxy or a crash can answer with HTML, and showing the
 * operator "Unexpected token <" helps nobody.
 */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Non-JSON body; fall through.
  }
  return `${fallback} (HTTP ${res.status})`;
}

/**
 * Whether the current account may open the panel. Resolves false rather than
 * throwing for the ordinary non-admin case — that is not an error condition,
 * it is the answer.
 */
export async function fetchAdminMe(): Promise<
  { userId: string; role: string | null; isRoot: boolean } | false
> {
  try {
    const res = await adminFetch("/admin/me");
    if (!res.ok) return false;
    const body = await res.json();
    if (typeof body?.userId !== "string") return false;
    return {
      userId: body.userId,
      role: typeof body.role === "string" ? body.role : null,
      isRoot: body.isRoot === true,
    };
  } catch {
    return false;
  }
}

export async function fetchAdminUsers(query: {
  q?: string;
  role?: string;
  limit?: number;
  offset?: number;
}): Promise<AdminUserListResponse | AdminApiError> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.role) params.set("role", query.role);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));

  try {
    const res = await adminFetch(`/admin/users?${params}`);
    if (!res.ok) return { error: await readError(res, "Failed to load users") };
    const parsed = AdminUserListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchAdminUsers: validation failed", parsed.error);
      return { error: "Server sent an unexpected response" };
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchAdminUsers: request failed", err);
    return { error: "Request failed" };
  }
}

async function readUserDetail(
  res: Response,
  fallback: string,
): Promise<AdminUserDetail | AdminApiError> {
  if (!res.ok) return { error: await readError(res, fallback) };
  const parsed = AdminUserDetailSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.warn("admin user detail: validation failed", parsed.error);
    return { error: "Server sent an unexpected response" };
  }
  return parsed.data;
}

export async function fetchAdminUser(
  id: string,
): Promise<AdminUserDetail | AdminApiError> {
  try {
    const res = await adminFetch(`/admin/users/${encodeURIComponent(id)}`);
    return await readUserDetail(res, "Failed to load user");
  } catch (err) {
    console.warn("fetchAdminUser: request failed", err);
    return { error: "Request failed" };
  }
}

export async function patchAdminUser(
  id: string,
  patch: AdminUserPatch,
): Promise<AdminUserDetail | AdminApiError> {
  try {
    const res = await adminFetch(`/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return await readUserDetail(res, "Failed to save changes");
  } catch (err) {
    console.warn("patchAdminUser: request failed", err);
    return { error: "Request failed" };
  }
}

export async function adjustAdminCredits(
  id: string,
  delta: number,
  reason: string,
): Promise<{ credits: number } | AdminApiError> {
  try {
    const res = await adminFetch(
      `/admin/users/${encodeURIComponent(id)}/credits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delta, reason }),
      },
    );
    if (!res.ok) {
      return { error: await readError(res, "Failed to adjust credits") };
    }
    const body = await res.json();
    if (typeof body?.credits !== "number") {
      return { error: "Server sent an unexpected response" };
    }
    return { credits: body.credits };
  } catch (err) {
    console.warn("adjustAdminCredits: request failed", err);
    return { error: "Request failed" };
  }
}

export async function banAdminUser(
  id: string,
  ban: AdminBanCreate,
): Promise<AdminUserDetail | AdminApiError> {
  try {
    const res = await adminFetch(
      `/admin/users/${encodeURIComponent(id)}/bans`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ban),
      },
    );
    return await readUserDetail(res, "Failed to ban user");
  } catch (err) {
    console.warn("banAdminUser: request failed", err);
    return { error: "Request failed" };
  }
}

export async function liftAdminBan(
  id: string,
  banId: string,
): Promise<AdminUserDetail | AdminApiError> {
  try {
    const res = await adminFetch(
      `/admin/users/${encodeURIComponent(id)}/bans/${encodeURIComponent(banId)}`,
      { method: "DELETE" },
    );
    return await readUserDetail(res, "Failed to lift ban");
  } catch (err) {
    console.warn("liftAdminBan: request failed", err);
    return { error: "Request failed" };
  }
}

export async function fetchAdminAudit(query: {
  targetId?: string;
  limit?: number;
  offset?: number;
}): Promise<AdminAuditListResponse | AdminApiError> {
  const params = new URLSearchParams();
  if (query.targetId) params.set("targetId", query.targetId);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));

  try {
    const res = await adminFetch(`/admin/audit?${params}`);
    if (!res.ok) return { error: await readError(res, "Failed to load log") };
    const parsed = AdminAuditListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchAdminAudit: validation failed", parsed.error);
      return { error: "Server sent an unexpected response" };
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchAdminAudit: request failed", err);
    return { error: "Request failed" };
  }
}
