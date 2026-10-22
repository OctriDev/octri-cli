/**
 * `octri webhooks …`: project webhooks that post Octri events (spec ingested,
 * SDK built or published, docs released) to Slack, Discord or any HTTPS URL.
 *
 * The signing secret of a generic webhook is shown once, on create; the API
 * never returns it again.
 */

import * as api from "../api.js";
import { flagBool, flagList, flagNumber, flagString } from "../args.js";
import { bold, dim, green, red, yellow } from "../ui/ansi.js";
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
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

import type { Context } from "../context.js";

const TYPES: readonly api.WebhookType[] = ["slack", "discord", "generic"];

/** `--events all` is every event the API lists; anything else is sent as given. */
async function resolveEvents(
  ctx: Context,
  projectId: string,
  events: string[],
): Promise<string[]> {
  return events.length === 1 && events[0] === "all"
    ? api.listWebhookEvents(ctx.client, projectId)
    : events;
}

export async function webhooksList(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const webhooks = await withSpinner("Loading webhooks", () =>
    api.listWebhooks(ctx.client, projectId),
  );

  emit({ projectId, webhooks }, () => {
    heading(`Webhooks ${dim(`(${webhooks.length})`)}`);
    table(
      webhooks,
      [
        { header: "label", value: (w) => bold(w.label), flex: 2, minWidth: 12 },
        { header: "type", value: (w) => w.type, flex: 6 },
        {
          header: "state",
          value: (w) =>
            !w.enabled
              ? dim("disabled")
              : (w.consecutiveFailures ?? 0) > 0
                ? yellow(`${w.consecutiveFailures} failing`)
                : green("enabled"),
          flex: 5,
        },
        { header: "events", value: (w) => String(w.events.length), align: "right", flex: 7 },
        { header: "last", value: (w) => relativeTime(w.lastDeliveryAt ?? undefined), flex: 5 },
        { header: "url", value: (w) => dim(w.urlPreview), flex: 1 },
        { header: "id", value: (w) => dim(w.id), flex: 4, minWidth: 24 },
      ],
      { emptyMessage: "No webhooks. Run `octri webhooks create <url> --events …`." },
    );
  });
}

export async function webhooksEvents(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const events = await withSpinner("Loading webhook events", () =>
    api.listWebhookEvents(ctx.client, projectId),
  );
  emit({ projectId, events }, () => {
    heading(`Webhook events ${dim(`(${events.length})`)}`);
    for (const event of events) line(`  ${event}`);
  });
}

/**
 * `octri webhooks create <https-url> --events a,b [--type slack|discord|generic]
 *   [--label "…"] [--disable]`. `--events all` subscribes to every event.
 */
export async function webhooksCreate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const url = ctx.args.positionals[0];
  const requested = flagList(ctx.args, "events");
  if (url === undefined || requested.length === 0) {
    throw new Error(
      "Usage: octri webhooks create <https-url> --events spec.ingested,sdk.published [--type slack|discord|generic] [--label name]",
    );
  }
  const type = (flagString(ctx.args, "type") ?? "generic") as api.WebhookType;
  if (!TYPES.includes(type)) {
    throw new Error(`Type must be one of ${TYPES.join(", ")}.`);
  }
  const events = await resolveEvents(ctx, projectId, requested);
  const label = flagString(ctx.args, "label") ?? new URL(url).hostname;

  const result = await withSpinner(`Creating webhook ${bold(label)}`, () =>
    api.createWebhook(ctx.client, projectId, {
      type,
      url,
      events,
      label,
      ...(flagBool(ctx.args, "disable") ? { enabled: false } : {}),
    }),
  );
  emit(result, () => {
    success(`Webhook ${bold(label)} created ${dim(result.webhook.id)}`);
    keyValues([["signing secret", bold(result.signingSecret)]]);
    warn("Store the signing secret now. It is not shown again.");
  });
}

/**
 * `octri webhooks update <id> [--url …] [--events a,b|all] [--label …]
 *   [--enable|--disable]`
 */
export async function webhooksUpdate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const webhookId = ctx.args.positionals[0];
  const url = flagString(ctx.args, "url");
  const label = flagString(ctx.args, "label");
  const requested = flagList(ctx.args, "events");
  const events =
    requested.length === 0 ? [] : await resolveEvents(ctx, ctx.projectId(), requested);
  const enabled = flagBool(ctx.args, "enable")
    ? true
    : flagBool(ctx.args, "disable")
      ? false
      : undefined;

  const input = {
    ...(url === undefined ? {} : { url }),
    ...(label === undefined ? {} : { label }),
    ...(events.length === 0 ? {} : { events }),
    ...(enabled === undefined ? {} : { enabled }),
  };
  if (webhookId === undefined || Object.keys(input).length === 0) {
    throw new Error(
      "Usage: octri webhooks update <id> [--url …] [--events a,b] [--label …] [--enable|--disable]",
    );
  }

  const webhook = await withSpinner("Updating webhook", () =>
    api.updateWebhook(ctx.client, projectId, webhookId, input),
  );
  emit(webhook, () => success(`Webhook ${bold(webhook.label)} updated.`));
}

export async function webhooksDelete(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const webhookId = ctx.args.positionals[0];
  if (webhookId === undefined) throw new Error("Usage: octri webhooks delete <id> --yes");
  if (!flagBool(ctx.args, "yes")) {
    warn("Deleting a webhook also drops its delivery history. Re-run with --yes.");
    return;
  }
  await withSpinner("Deleting webhook", () =>
    api.deleteWebhook(ctx.client, projectId, webhookId),
  );
  emit({ deleted: true, id: webhookId }, () => success("Webhook deleted."));
}

export async function webhooksTest(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const webhookId = ctx.args.positionals[0];
  if (webhookId === undefined) throw new Error("Usage: octri webhooks test <id>");
  const result = await withSpinner("Queueing a test delivery", () =>
    api.testWebhook(ctx.client, projectId, webhookId),
  );
  emit(result, () => {
    success("Test delivery queued.");
    note(`octri webhooks deliveries ${webhookId}: see how it went`);
  });
}

/** `octri webhooks deliveries <id> [--status success|failure] [--limit 25]` */
export async function webhooksDeliveries(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const webhookId = ctx.args.positionals[0];
  if (webhookId === undefined) {
    throw new Error("Usage: octri webhooks deliveries <id> [--status success|failure]");
  }
  const status = flagString(ctx.args, "status");
  if (status !== undefined && status !== "success" && status !== "failure") {
    throw new Error("--status must be success or failure.");
  }

  const result = await withSpinner("Loading deliveries", () =>
    api.listWebhookDeliveries(ctx.client, projectId, webhookId, {
      limit: flagNumber(ctx.args, "limit") ?? 25,
      ...(status === undefined ? {} : { status }),
    }),
  );
  emit({ projectId, webhookId, ...result }, () => {
    heading(`Deliveries ${dim(`(${result.deliveries.length} of ${result.total})`)}`);
    table(
      result.deliveries,
      [
        { header: "when", value: (d) => relativeTime(d.attemptedAt), flex: 5 },
        { header: "event", value: (d) => bold(d.event), flex: 2, minWidth: 16 },
        {
          header: "status",
          value: (d) => (d.status === "success" ? green("success") : red("failure")),
          flex: 5,
        },
        {
          header: "http",
          value: (d) => (d.httpCode === undefined ? "" : String(d.httpCode)),
          align: "right",
          flex: 7,
        },
        { header: "attempt", value: (d) => String(d.attempt), align: "right", flex: 7 },
        { header: "error", value: (d) => dim(d.error ?? ""), flex: 1 },
      ],
      { emptyMessage: "No deliveries yet." },
    );
  });
}
