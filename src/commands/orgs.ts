/**
 * `octri orgs …` — the organisation behind the session: who is in it, who has
 * been invited, what it is using, and what it is being charged.
 *
 * Every route here is scoped to the session's *active* org, so `orgs switch`
 * re-issues the token rather than passing an id around: the API rejects reads
 * for any org other than the one the JWT names.
 */

import * as api from "../api.js";
import { flagString } from "../args.js";
import { updateProfile } from "../config.js";
import { accent, bold, dim, green, red, yellow } from "../ui/ansi.js";
import {
  emit,
  heading,
  keyValues,
  line,
  note,
  relativeTime,
  success,
  warn,
} from "../ui/output.js";
import * as prompt from "../ui/prompt.js";
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

import type { Context } from "../context.js";

/** The org the session is currently acting as. */
async function activeOrgId(ctx: Context): Promise<string> {
  const explicit = flagString(ctx.args, "org");
  if (explicit !== undefined) return explicit;
  const who = await api.me(ctx.client);
  return who.org.id;
}

export async function orgsList(ctx: Context): Promise<void> {
  const [orgs, who] = await withSpinner("Loading organisations", async () =>
    Promise.all([api.listOrgs(ctx.client), api.me(ctx.client)]),
  );

  emit({ orgs, current: who.org.id }, () => {
    heading(`Organisations ${dim(`(${orgs.length})`)}`);
    table(
      orgs,
      [
        {
          header: "",
          value: (o) => (o.id === who.org.id ? green("●") : dim("○")),
          minWidth: 1,
          flex: 9,
        },
        { header: "name", value: (o) => bold(o.name), flex: 2, minWidth: 14 },
        { header: "role", value: (o) => dim(o.role ?? "—"), flex: 6 },
        {
          header: "plan",
          // Only the active org's plan is in the session payload.
          value: (o) => (o.plan === "" ? dim("—") : planLabel(o.plan)),
          flex: 6,
        },
        { header: "id", value: (o) => dim(o.id), flex: 7, minWidth: 24 },
      ],
      { emptyMessage: "No organisations." },
    );
    if (orgs.length > 1) note("octri orgs switch <id>");
  });
}

function planLabel(plan: string): string {
  if (plan === "enterprise" || plan === "business") return accent(plan);
  if (plan === "free") return dim(plan);
  return plan;
}

export async function orgsShow(ctx: Context): Promise<void> {
  const orgId = ctx.args.positionals[0] ?? (await activeOrgId(ctx));
  const org = await withSpinner("Loading organisation", () =>
    api.getOrg(ctx.client, orgId),
  );

  emit(org, () => {
    heading(org.name);
    keyValues([
      ["id", org.id],
      ["slug", org.slug ?? "—"],
      ["plan", planLabel(org.plan)],
      ["created", relativeTime(org.createdAt)],
      [
        "SDK languages",
        org.preferredSdkLanguages === undefined ||
        org.preferredSdkLanguages.length === 0
          ? "—"
          : org.preferredSdkLanguages.join(", "),
      ],
    ]);

    const limits = org.planLimits;
    if (limits !== undefined) {
      line();
      heading("Plan limits");
      keyValues(
        Object.entries(limits)
          .filter(([, v]) => typeof v !== "object")
          .map(([k, v]) => [k, String(v)] as const),
      );
    }
  });
}

export async function orgsUsage(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const usage = await withSpinner("Loading usage", () =>
    api.orgUsage(ctx.client, orgId),
  );

  emit(usage, () => {
    heading("Usage this period");
    keyValues(
      Object.entries(usage)
        .filter(([, v]) => typeof v !== "object" || v === null)
        .map(([k, v]) => [k, String(v)] as const),
    );
    // Nested groups (credits, monitoring, …) are rendered one level down rather
    // than flattened, so a key like `credits.paid.remaining` stays readable.
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        continue;
      }
      line();
      heading(key);
      keyValues(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => typeof v !== "object" || v === null)
          .map(([k, v]) => [k, String(v)] as const),
      );
    }
  });
}

export async function orgsBilling(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const status = await withSpinner("Loading billing status", () =>
    api.billingStatus(ctx.client, orgId),
  );

  emit(status, () => {
    heading("Billing");
    keyValues([
      ["plan", planLabel(status.plan)],
      ["status", billingColour(status.status)],
      ["renews", relativeTime(status.currentPeriodEnd)],
      ...(status.trialEndsAt === undefined
        ? []
        : ([["trial ends", relativeTime(status.trialEndsAt)]] as const)),
      ...(status.cancelAtPeriodEnd === true
        ? ([["cancelling", yellow("at period end")]] as const)
        : []),
    ]);
  });
}

function billingColour(status: string | undefined): string {
  if (status === undefined) return dim("—");
  if (status === "active" || status === "trialing") return green(status);
  if (status === "past_due" || status === "unpaid") return red(status);
  return yellow(status);
}

export async function orgsInvoices(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const invoices = await withSpinner("Loading invoices", () =>
    api.listInvoices(ctx.client, orgId),
  );

  emit(invoices, () => {
    heading(`Invoices ${dim(`(${invoices.length})`)}`);
    table(
      invoices,
      [
        {
          header: "invoice",
          value: (i) => bold(i.number ?? i.id ?? "—"),
          flex: 2,
          minWidth: 12,
        },
        {
          header: "amount",
          value: (i) =>
            i.amount === undefined
              ? dim("—")
              : `${(i.amount / 100).toFixed(2)} ${(i.currency ?? "").toUpperCase()}`,
          flex: 5,
        },
        { header: "status", value: (i) => i.status ?? dim("—"), flex: 6 },
        { header: "date", value: (i) => relativeTime(i.createdAt), flex: 5 },
      ],
      { emptyMessage: "No invoices yet." },
    );
  });
}

/**
 * `octri orgs switch <id>` — swaps the session onto another org. The API mints
 * a fresh token pair, so the stored profile is rewritten rather than reused.
 */
export async function orgsSwitch(ctx: Context): Promise<void> {
  let orgId = ctx.args.positionals[0];

  if (orgId === undefined) {
    const orgs = await withSpinner("Loading organisations", () =>
      api.listOrgs(ctx.client),
    );
    orgId = await prompt.select(
      "Switch to",
      orgs.map((o) => ({ label: `${o.name} ${dim(o.plan)}`, value: o.id })),
    );
  }

  const tokens = await withSpinner("Switching organisation", () =>
    api.switchOrg(ctx.client, orgId),
  );

  // Switching orgs invalidates the selected project — it belonged to the old one.
  updateProfile(
    {
      ...(tokens.accessToken === undefined
        ? {}
        : { accessToken: tokens.accessToken }),
      ...(tokens.refreshToken === undefined
        ? {}
        : { refreshToken: tokens.refreshToken }),
      defaultProject: undefined,
    },
    ctx.settings.profile,
  );

  emit({ orgId, switched: true }, () => {
    success(`Now acting as ${bold(orgId)}`);
    note("octri projects use — pick a project in this organisation");
  });
}

// ─── Members ──────────────────────────────────────────────────────────────────

export async function orgMembers(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const members = await withSpinner("Loading members", () =>
    api.listMembers(ctx.client, orgId),
  );

  emit(members, () => {
    heading(`Members ${dim(`(${members.length})`)}`);
    table(
      members,
      [
        { header: "name", value: (m) => bold(m.name || m.email), flex: 2, minWidth: 14 },
        { header: "email", value: (m) => dim(m.email), flex: 2, minWidth: 18 },
        { header: "role", value: (m) => roleColour(m.role), flex: 6 },
        { header: "status", value: (m) => statusColour(m.status), flex: 6 },
        {
          header: "2FA",
          value: (m) => (m.mfaEnabled === true ? green("on") : dim("off")),
          flex: 9,
        },
        { header: "active", value: (m) => relativeTime(m.lastActiveAt), flex: 5 },
        { header: "id", value: (m) => dim(m.userId), flex: 7, minWidth: 24 },
      ],
      { emptyMessage: "No members." },
    );
  });
}

function roleColour(role: string): string {
  if (role === "owner") return accent(role);
  if (role === "admin") return green(role);
  return dim(role);
}

function statusColour(status: string): string {
  if (status === "active") return green(status);
  if (status === "suspended") return red(status);
  return yellow(status);
}

export async function orgMemberRole(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const [userId, role] = ctx.args.positionals;
  if (userId === undefined || role === undefined) {
    throw new Error("Usage: octri orgs members role <userId> <admin|member|viewer>");
  }

  await withSpinner(`Setting ${dim(userId)} to ${bold(role)}`, () =>
    api.updateMember(ctx.client, orgId, userId, { role }),
  );
  emit({ userId, role }, () => success(`${userId} is now ${roleColour(role)}.`));
}

export async function orgMemberRemove(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const userId = ctx.args.positionals[0];
  if (userId === undefined) {
    throw new Error("Usage: octri orgs members remove <userId>");
  }
  if (ctx.args.flags["yes"] !== true) {
    warn("Removing a member revokes their access. Re-run with --yes to confirm.");
    return;
  }

  await withSpinner("Removing member", () =>
    api.removeMember(ctx.client, orgId, userId),
  );
  emit({ removed: userId }, () => success("Member removed."));
}

// ─── Invites ──────────────────────────────────────────────────────────────────

export async function orgInvites(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const invites = await withSpinner("Loading invites", () =>
    api.listInvites(ctx.client, orgId),
  );

  emit(invites, () => {
    heading(`Pending invites ${dim(`(${invites.length})`)}`);
    table(
      invites,
      [
        { header: "email", value: (i) => bold(i.email), flex: 1, minWidth: 20 },
        { header: "role", value: (i) => roleColour(i.role), flex: 6 },
        { header: "sent", value: (i) => relativeTime(i.createdAt), flex: 5 },
        { header: "expires", value: (i) => relativeTime(i.expiresAt), flex: 5 },
        { header: "id", value: (i) => dim(i.id), flex: 7, minWidth: 24 },
      ],
      { emptyMessage: "No pending invites." },
    );
  });
}

export async function orgInviteCreate(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const email = ctx.args.positionals[0] ?? flagString(ctx.args, "email");
  const role = flagString(ctx.args, "role") ?? "member";
  if (email === undefined) {
    throw new Error(
      "Usage: octri orgs invites create <email> [--role admin|member|viewer]",
    );
  }

  const invite = await withSpinner(`Inviting ${bold(email)}`, () =>
    api.createInvite(ctx.client, orgId, email, role),
  );
  emit(invite, () => success(`Invited ${bold(email)} as ${roleColour(role)}.`));
}

export async function orgInviteResend(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const inviteId = ctx.args.positionals[0];
  if (inviteId === undefined) {
    throw new Error("Usage: octri orgs invites resend <inviteId>");
  }
  await withSpinner("Resending invite", () =>
    api.resendInvite(ctx.client, orgId, inviteId),
  );
  emit({ resent: inviteId }, () => success("Invite resent."));
}

export async function orgInviteRevoke(ctx: Context): Promise<void> {
  const orgId = await activeOrgId(ctx);
  const inviteId = ctx.args.positionals[0];
  if (inviteId === undefined) {
    throw new Error("Usage: octri orgs invites revoke <inviteId>");
  }
  await withSpinner("Revoking invite", () =>
    api.revokeInvite(ctx.client, orgId, inviteId),
  );
  emit({ revoked: inviteId }, () => success("Invite revoked."));
}
