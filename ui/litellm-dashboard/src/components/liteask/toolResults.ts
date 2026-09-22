import { z } from "zod";

const scalars = new Set([
  "id",
  "key_alias",
  "team_id",
  "team_alias",
  "team_name",
  "organization_id",
  "project_id",
  "user_id",
  "user_email",
  "user_alias",
  "user_role",
  "user",
  "end_user",
  "role",
  "customer",
  "budget_id",
  "spend",
  "max_budget",
  "soft_budget",
  "max_budget_in_team",
  "budget_duration",
  "budget_reset_at",
  "budget_source",
  "rpm_limit",
  "tpm_limit",
  "tpd_limit",
  "max_parallel_requests",
  "blocked",
  "expires",
  "created_at",
  "updated_at",
  "request_id",
  "model",
  "model_id",
  "model_group",
  "status",
  "call_type",
  "startTime",
  "endTime",
  "request_duration_ms",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cache_hit",
  "date",
  "group_by_day",
  "total_cost",
  "total_spend",
  "total_input_tokens",
  "total_output_tokens",
  "api_requests",
  "successful_requests",
  "failed_requests",
  "total",
  "total_count",
  "total_pages",
  "page",
  "current_page",
  "page_size",
  "total_is_capped",
  "key_count",
]);
const arrays = new Set(["models", "teams", "members", "admins"]);
const containers = new Set([
  "data",
  "info",
  "team_info",
  "user_info",
  "meta",
  "keys",
  "teams",
  "users",
  "budgets",
  "members_with_roles",
  "team_memberships",
  "updated_team_memberships",
  "updated_users",
  "model_details",
  "customers",
  "team_member_budget_table",
  "litellm_budget_table",
]);
const keyRowPaths: Record<string, readonly string[]> = {
  keys_list: ["keys"],
  key_info: ["info"],
  team_info: ["keys"],
  user_info: ["keys"],
};
const spendRowPaths: Record<string, readonly string[]> = {
  spend_report: [""],
  team_spend_report: [""],
  key_spend_report: [""],
  request_logs: ["data"],
};
const record = z.record(z.unknown());
const keyHash = /^[a-f0-9]{64}$/i;
const MAX_ROWS = 50;
const MAX_RESULT_LENGTH = 16_000;

type ProjectionContext = { operation: string; secrets: readonly string[]; path: string; depth: number };

function selectResult(value: unknown, context: ProjectionContext): unknown {
  if (context.depth > 6) return { truncated: true };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ROWS).map((item) => selectResult(item, { ...context, depth: context.depth + 1 }));
    return value.length > MAX_ROWS ? { items, truncated: true, returned_count: items.length } : items;
  }
  const parsed = record.safeParse(value);
  if (!parsed.success) return null;
  const safeString = (item: string) =>
    context.secrets.some((secret) => secret.length > 0 && item.includes(secret)) ? "[redacted]" : item.slice(0, 500);
  return Object.fromEntries(
    Object.entries(parsed.data).flatMap(([name, item]) => {
      const keyIdentity =
        ["token", "token_id"].includes(name) && keyRowPaths[context.operation]?.includes(context.path);
      const spendIdentity = name === "api_key" && spendRowPaths[context.operation]?.includes(context.path);
      const identity = keyIdentity || spendIdentity;
      const validHash = typeof item === "string" && keyHash.test(item);
      if (identity && validHash) return [["key_hash", safeString(item)]];
      const scalar = item === null || ["number", "boolean", "string"].includes(typeof item);
      if (scalars.has(name) && scalar) return [[name, typeof item === "string" ? safeString(item) : item]];
      if (arrays.has(name) && Array.isArray(item) && item.every((entry) => typeof entry === "string"))
        return [[name, item.slice(0, MAX_ROWS).map(safeString)]];
      if (!containers.has(name) || item === null || typeof item !== "object") return [];
      return [
        [
          name,
          selectResult(item, {
            ...context,
            path: context.path ? `${context.path}.${name}` : name,
            depth: context.depth + 1,
          }),
        ],
      ];
    }),
  );
}

export function projectToolResult(value: unknown, operation: string, secrets: readonly string[]): unknown {
  const context = { operation, secrets, path: "", depth: 0 };
  const result = selectResult(value, context);
  return JSON.stringify(result).length <= MAX_RESULT_LENGTH
    ? result
    : { truncated: true, message: "Result too large. Use a smaller page or narrower filter." };
}

export function generatedKey(value: unknown): string | undefined {
  const parsed = z.object({ key: z.string().min(1) }).safeParse(value);
  return parsed.success ? parsed.data.key : undefined;
}
