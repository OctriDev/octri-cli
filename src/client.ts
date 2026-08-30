/**
 * HTTP client for the Octri API.
 *
 * Everything the dashboard and the public developer API expose lives under one
 * `/api/v1` prefix, so a single base URL covers both. Auth is a bearer JWT
 * (`verifyJwt` accepts `Authorization` before falling back to the browser's
 * httpOnly cookie) or an `X-API-Key` for the public surface.
 *
 * A 401 with a stored refresh token triggers exactly one silent refresh + retry;
 * anything beyond that is surfaced to the user as "run `octri auth login`".
 */

import { updateProfile, type Resolved } from "./config.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
    readonly path: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when re-authenticating is the fix. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not signed in. Run `octri auth login` first.");
    this.name = "NotAuthenticatedError";
  }
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

/**
 * Pulls a named cookie out of a response's Set-Cookie headers. Login returns
 * the session only as cookies — the JSON body carries user/org, not tokens — so
 * this is how the CLI acquires a bearer token in the first place.
 */
export function cookieFrom(
  response: Response,
  name: string,
): string | undefined {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];

  for (const entry of raw) {
    for (const part of entry.split(/,(?=[^;]+?=)/)) {
      const [pair] = part.trim().split(";");
      if (pair === undefined) continue;
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      if (pair.slice(0, eq).trim() === name) {
        return decodeURIComponent(pair.slice(eq + 1).trim());
      }
    }
  }
  return undefined;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skips auth headers — used by /auth/login itself. */
  anonymous?: boolean;
  /** Returns the raw Response instead of parsed JSON (artifact downloads). */
  raw?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class OctriClient {
  private accessToken: string | undefined;

  constructor(
    private readonly settings: Resolved,
    /** Persist refreshed tokens back to the profile (off for one-shot runs). */
    private readonly persist = true,
  ) {
    this.accessToken = settings.accessToken;
  }

  get apiUrl(): string {
    return this.settings.apiUrl;
  }

  get hasCredentials(): boolean {
    return this.accessToken !== undefined || this.settings.apiKey !== undefined;
  }

  /** The project a command should act on when `--project` was not given. */
  requireProject(explicit?: string): string {
    const id = explicit ?? this.settings.defaultProject;
    if (id === undefined || id === "") {
      throw new Error(
        "No project selected. Pass --project <id>, or run `octri projects use <id>`.",
      );
    }
    return id;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);

    // One silent refresh, then give up and tell the user to sign in again.
    if (response.status === 401 && options.anonymous !== true) {
      const refreshed = await this.refresh();
      if (refreshed) {
        const retry = await this.send(path, options);
        return this.unwrap<T>(retry, path, options);
      }
    }

    return this.unwrap<T>(response, path, options);
  }

  /** GET that returns the raw Response — for streaming artifact downloads. */
  async fetchRaw(url: string): Promise<Response> {
    const target = new URL(url);
    const api = new URL(this.settings.apiUrl);
    const response = await fetch(url, {
      // Never forward an Octri session or API key to a CDN/R2 host. Presigned
      // URLs authenticate in their query string; an Authorization header can
      // invalidate them and would disclose the caller's Octri credential.
      headers: target.origin === api.origin ? this.authHeaders() : {},
    });
    if (!response.ok) {
      target.search = "";
      target.hash = "";
      throw new ApiError(
        `Download failed (${response.status})`,
        response.status,
        "DOWNLOAD_FAILED",
        undefined,
        target.toString(),
      );
    }
    return response;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private buildUrl(path: string, query: RequestOptions["query"]): string {
    const url = new URL(
      `${this.settings.apiUrl}${path.startsWith("/") ? path : `/${path}`}`,
    );
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.accessToken !== undefined) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    } else if (this.settings.apiKey !== undefined) {
      headers["X-API-Key"] = this.settings.apiKey;
    }
    return headers;
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const {
      method = "GET",
      body,
      query,
      anonymous = false,
      headers = {},
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    if (!anonymous && !this.hasCredentials) throw new NotAuthenticatedError();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(this.buildUrl(path, query), {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "octri-cli",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(anonymous ? {} : this.authHeaders()),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ApiError(
          `Request timed out after ${Math.round(timeoutMs / 1000)}s`,
          0,
          "TIMEOUT",
          undefined,
          path,
        );
      }
      throw new ApiError(
        `Cannot reach ${this.settings.apiUrl} — ${(err as Error).message}`,
        0,
        "NETWORK",
        undefined,
        path,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async unwrap<T>(
    response: Response,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    if (options.raw === true) return response as unknown as T;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const shaped = parsed as
        | { error?: { code?: string; message?: string } }
        | undefined;
      throw new ApiError(
        shaped?.error?.message ??
          (typeof parsed === "string" && parsed.length > 0
            ? parsed
            : `Request failed with ${response.status}`),
        response.status,
        shaped?.error?.code ?? String(response.status),
        parsed,
        path,
      );
    }

    return parsed as T;
  }

  /**
   * Exchanges the stored refresh cookie for a new access token. Returns false
   * when there is nothing to refresh with, which the caller reports as a 401.
   */
  private async refresh(): Promise<boolean> {
    const refreshToken = this.settings.refreshToken;
    if (refreshToken === undefined) return false;

    const response = await fetch(`${this.settings.apiUrl}/auth/refresh`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: `refresh_token=${refreshToken}`,
      },
    });
    if (!response.ok) return false;

    const access = cookieFrom(response, "access_token");
    if (access === undefined) return false;
    const nextRefresh = cookieFrom(response, "refresh_token") ?? refreshToken;

    this.accessToken = access;
    if (this.persist) {
      updateProfile(
        { accessToken: access, refreshToken: nextRefresh },
        this.settings.profile,
      );
    }
    return true;
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface SessionOrg {
  id: string;
  name: string;
  plan: string;
  billingStatus: string;
}

export interface LoginResult {
  user: SessionUser;
  org: SessionOrg;
  accessToken: string;
  refreshToken: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSessionIdentity(
  payload: unknown,
): payload is { user: SessionUser; org: SessionOrg } {
  if (!isRecord(payload) || !isRecord(payload.user) || !isRecord(payload.org)) {
    return false;
  }
  return (
    typeof payload.user.id === "string" &&
    typeof payload.user.email === "string" &&
    (payload.user.name === undefined ||
      typeof payload.user.name === "string") &&
    typeof payload.org.id === "string" &&
    typeof payload.org.name === "string" &&
    typeof payload.org.plan === "string" &&
    typeof payload.org.billingStatus === "string"
  );
}

/** MFA-enabled accounts get a challenge instead of a session. */
export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  expiresIn: number;
  hasBackupCodes: boolean;
}

export async function login(
  apiUrl: string,
  email: string,
  password: string,
): Promise<LoginResult | MfaChallenge> {
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const payload = (await response.json().catch(() => undefined)) as
    | (LoginResult & MfaChallenge & { error?: { message?: string } })
    | undefined;

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message ?? `Login failed (${response.status})`,
      response.status,
      "LOGIN_FAILED",
      payload,
      "/auth/login",
    );
  }

  if (payload?.mfaRequired === true) return payload as MfaChallenge;

  const accessToken = cookieFrom(response, "access_token");
  if (accessToken === undefined) {
    throw new Error(
      "Login succeeded but no session cookie was returned — is this an Octri API?",
    );
  }
  if (!hasSessionIdentity(payload)) {
    throw new Error("Login succeeded but the session identity was missing.");
  }

  return {
    user: payload.user,
    org: payload.org,
    accessToken,
    refreshToken: cookieFrom(response, "refresh_token"),
  };
}

/** Completes an MFA login with a TOTP or backup code. */
export async function completeMfa(
  apiUrl: string,
  challengeToken: string,
  code: string,
): Promise<LoginResult> {
  const response = await fetch(`${apiUrl}/auth/mfa/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ challengeToken, code }),
  });

  const payload = (await response.json().catch(() => undefined)) as
    | (LoginResult & { error?: { message?: string } })
    | undefined;

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message ?? `MFA challenge failed (${response.status})`,
      response.status,
      "MFA_FAILED",
      payload,
      "/auth/mfa/challenge",
    );
  }

  const accessToken = cookieFrom(response, "access_token");
  if (accessToken === undefined) {
    throw new Error("MFA challenge succeeded but no session cookie came back.");
  }
  if (!hasSessionIdentity(payload)) {
    throw new Error(
      "MFA challenge succeeded but the session identity was missing.",
    );
  }

  return {
    user: payload.user,
    org: payload.org,
    accessToken,
    refreshToken: cookieFrom(response, "refresh_token"),
  };
}
