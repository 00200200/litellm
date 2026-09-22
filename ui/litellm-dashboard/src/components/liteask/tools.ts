import { zodFunction } from "openai/helpers/zod";
import { z } from "zod";
import { apiClient } from "@/components/networking";
import { fetchClient } from "@/lib/http/api";
import { ApiError } from "@/lib/http/client";
import type { components } from "@/lib/http/schema";
import { generatedKey, projectToolResult } from "./toolResults";

export interface LiteAskConfirmation {
  id: string;
  name: string;
  title: string;
  arguments: Record<string, unknown>;
  destructive?: boolean;
}

export interface LiteAskGeneratedKey {
  key: string;
  label: string;
}

export interface ToolContext {
  accessToken: string;
  signal: AbortSignal;
  confirm: (proposal: LiteAskConfirmation) => Promise<boolean>;
  onGeneratedKey: (value: LiteAskGeneratedKey) => void;
  assertCurrent: () => void;
  beforeTool: () => void;
  onMutationState?: (pending: boolean) => void;
  onMutationSuccess?: (operation: { name: string; title: string }) => void;
}

type Schemas = components["schemas"];
const text = z.string().min(1).max(200);
const optionalText = z.union([text, z.null()]);
const amount = z.union([z.number().nonnegative(), z.null()]);
const count = z.union([z.number().int().nonnegative(), z.null()]);
const models = z.union([z.array(text).max(50), z.null()]);
const hash = z.string().regex(/^[a-f0-9]{64}$/i, "Use a key hash from keys_list, not a raw key");
const optionalHash = z.union([hash, z.null()]);
const page = z.number().int().min(1);
const pageSize = z.number().int().min(1).max(50);
const dates = { start_date: z.string().date(), end_date: z.string().date() };
const limits = { max_budget: amount, budget_duration: optionalText, rpm_limit: count, tpm_limit: count };
const userRole = z.union([
  z.enum(["proxy_admin", "proxy_admin_viewer", "internal_user", "internal_user_viewer"]),
  z.null(),
]);
const keyFields = {
  key_alias: optionalText,
  team_id: optionalText,
  user_id: optionalText,
  models,
  ...limits,
  budget_id: optionalText,
  duration: optionalText,
};
const teamFields = { team_alias: optionalText, organization_id: optionalText, models, ...limits };
const userFields = { user_email: optionalText, user_alias: optionalText, user_role: userRole, models, ...limits };
const budgetFields = { ...limits, soft_budget: amount, max_parallel_requests: count };
const memberFields = {
  team_id: text,
  user_id: text,
  role: z.enum(["admin", "user"]),
  max_budget_in_team: amount,
  budget_duration: optionalText,
};

const keyListFields = {
  page,
  page_size: pageSize,
  team_id: optionalText,
  user_id: optionalText,
  key_alias: optionalText,
};

const teamListFields = { page, page_size: pageSize, search: optionalText, organization_id: optionalText };

const userListFields = { page, page_size: pageSize, user_email: optionalText, user_role: userRole };

const spendFields = {
  ...dates,
  group_by: z.enum(["team", "customer", "api_key"]),
  team_id: optionalText,
  internal_user_id: optionalText,
};

const logFields = {
  ...dates,
  page,
  page_size: pageSize,
  team_id: optionalText,
  user_id: optionalText,
  api_key: optionalHash,
  request_id: optionalText,
  model: optionalText,
  status_filter: z.union([z.enum(["success", "failure"]), z.null()]),
};

function present<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

const limitBody = (args: z.output<z.ZodObject<typeof limits>>) => ({
  max_budget: present(args.max_budget),
  budget_duration: present(args.budget_duration),
  rpm_limit: present(args.rpm_limit),
  tpm_limit: present(args.tpm_limit),
});
const keyBody = (args: z.output<z.ZodObject<typeof keyFields>>) => ({
  ...limitBody(args),
  key_alias: present(args.key_alias),
  team_id: present(args.team_id),
  user_id: present(args.user_id),
  models: present(args.models),
  budget_id: present(args.budget_id),
  duration: present(args.duration),
});
const teamBody = (args: z.output<z.ZodObject<typeof teamFields>>) => ({
  ...limitBody(args),
  team_alias: present(args.team_alias),
  organization_id: present(args.organization_id),
  models: present(args.models),
});
const userBody = (args: z.output<z.ZodObject<typeof userFields>>) => ({
  ...limitBody(args),
  user_email: present(args.user_email),
  user_alias: present(args.user_alias),
  user_role: present(args.user_role),
  models: present(args.models),
});
const budgetBody = (args: z.output<z.ZodObject<typeof budgetFields>>) => ({
  ...limitBody(args),
  soft_budget: present(args.soft_budget),
  max_parallel_requests: present(args.max_parallel_requests),
});

export function createLiteAskTools(context: ToolContext) {
  const current = () => {
    context.signal.throwIfAborted();
    context.assertCurrent();
  };
  const post = <Name extends keyof Schemas>(path: string, body: Partial<Schemas[Name]>) =>
    apiClient.post<unknown>(path, { accessToken: context.accessToken, body, signal: context.signal });
  const define =
    (mode: "read" | "write" | "delete") =>
    <Shape extends z.ZodRawShape>(
      name: string,
      title: string,
      shape: Shape,
      execute: (args: z.output<z.ZodObject<Shape>>) => Promise<unknown>,
    ) => {
      const write = mode !== "read";
      const destructive = mode === "delete";
      const definition = {
        name,
        description: `${title}. Optional null values mean omitted or unchanged. ${write ? "Requires the administrator to review and confirm before execution." : "Read-only operation."}`,
        parameters: z.object(shape).strict(),
        function: async (args: z.output<z.ZodObject<Shape>>) => {
          current();
          context.beforeTool();
          if (write) {
            const proposal: LiteAskConfirmation = {
              id: crypto.randomUUID(),
              name,
              title,
              arguments: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null)),
              destructive,
            };
            const approved = await context.confirm(proposal);
            current();
            if (!approved) throw new Error("Action cancelled. No change was sent.");
            context.onMutationState?.(true);
          }
          try {
            current();
            const result = await execute(args);
            current();
            const secret = name === "key_create" || name === "user_create" ? generatedKey(result) : undefined;
            if (write) {
              if (secret) context.onGeneratedKey({ key: secret, label: title });
              context.onMutationSuccess?.({ name, title });
            }
            return {
              operation: name,
              success: true,
              result: projectToolResult(result, name, [context.accessToken, ...(secret ? [secret] : [])]),
            };
          } catch (error) {
            current();
            const status = error instanceof ApiError ? error.status : undefined;
            if (write)
              throw new Error(
                `The change could not be verified${status ? ` (HTTP ${status})` : ""}. Check the resource before trying again.`,
              );
            return { operation: name, success: false, status, message: "The gateway could not complete this lookup." };
          } finally {
            if (write) context.onMutationState?.(false);
          }
        },
      };
      return zodFunction(definition);
    };
  const tool = define("read");
  const change = define("write");
  const remove = define("delete");
  const read = <T>(response: { data?: T }) => response.data;
  return [
    tool("keys_list", "List virtual keys", keyListFields, async (a) =>
      read(
        await fetchClient.GET("/key/list", {
          signal: context.signal,
          params: {
            query: {
              page: a.page,
              size: a.page_size,
              team_id: present(a.team_id),
              user_id: present(a.user_id),
              key_alias: present(a.key_alias),
              return_full_object: true,
            },
          },
        }),
      ),
    ),
    tool("key_info", "View a virtual key", { key: hash }, async (a) =>
      read(await fetchClient.GET("/key/info", { signal: context.signal, params: { query: a } })),
    ),
    change("key_create", "Create a virtual key", keyFields, (a) =>
      post<"GenerateKeyRequest">("/key/generate", keyBody(a)),
    ),
    change("key_update", "Update a virtual key", { key: hash, ...keyFields }, (a) =>
      post<"UpdateKeyRequest">("/key/update", { key: a.key, ...keyBody(a) }),
    ),
    remove("key_delete", "Delete virtual keys", { keys: z.array(hash).min(1).max(20) }, async (a) =>
      read(await fetchClient.POST("/key/delete", { signal: context.signal, body: a })),
    ),
    change("key_block", "Block a virtual key", { key: hash }, async (a) =>
      read(await fetchClient.POST("/key/block", { signal: context.signal, body: a })),
    ),
    change("key_unblock", "Unblock a virtual key", { key: hash }, async (a) =>
      read(await fetchClient.POST("/key/unblock", { signal: context.signal, body: a })),
    ),
    tool("teams_list", "List teams", teamListFields, async (a) =>
      read(
        await fetchClient.GET("/v2/team/list", {
          signal: context.signal,
          params: {
            query: {
              page: a.page,
              page_size: a.page_size,
              search: present(a.search),
              organization_id: present(a.organization_id),
            },
          },
        }),
      ),
    ),
    tool("team_info", "View a team and its members", { team_id: text }, async (a) =>
      read(await fetchClient.GET("/team/info", { signal: context.signal, params: { query: { ...a, key_limit: 50 } } })),
    ),
    change("team_create", "Create a team", teamFields, (a) => post<"NewTeamRequest">("/team/new", teamBody(a))),
    change("team_update", "Update a team", { team_id: text, ...teamFields }, (a) =>
      post<"UpdateTeamRequest">("/team/update", { team_id: a.team_id, ...teamBody(a) }),
    ),
    remove(
      "team_delete",
      "Delete teams, their keys and team models",
      { team_ids: z.array(text).min(1).max(20) },
      async (a) => read(await fetchClient.POST("/team/delete", { signal: context.signal, body: a })),
    ),
    change("team_member_add", "Add a team member", memberFields, async (a) =>
      read(
        await fetchClient.POST("/team/member_add", {
          signal: context.signal,
          body: {
            team_id: a.team_id,
            member: { user_id: a.user_id, role: a.role },
            max_budget_in_team: present(a.max_budget_in_team),
            budget_duration: present(a.budget_duration),
          },
        }),
      ),
    ),
    change(
      "team_member_update",
      "Update a team member",
      { ...memberFields, rpm_limit: count, tpm_limit: count },
      async (a) =>
        read(
          await fetchClient.POST("/team/member_update", {
            signal: context.signal,
            body: {
              team_id: a.team_id,
              user_id: a.user_id,
              role: a.role,
              max_budget_in_team: present(a.max_budget_in_team),
              budget_duration: present(a.budget_duration),
              rpm_limit: present(a.rpm_limit),
              tpm_limit: present(a.tpm_limit),
            },
          }),
        ),
    ),
    remove(
      "team_member_delete",
      "Remove a team member and their team keys",
      { team_id: text, user_id: text },
      async (a) => read(await fetchClient.POST("/team/member_delete", { signal: context.signal, body: a })),
    ),
    tool("users_list", "List users", userListFields, async (a) =>
      read(
        await fetchClient.GET("/user/list", {
          signal: context.signal,
          params: {
            query: {
              page: a.page,
              page_size: a.page_size,
              user_email: present(a.user_email),
              user_role: present(a.user_role),
            },
          },
        }),
      ),
    ),
    tool("user_info", "View a user", { user_id: text }, async (a) =>
      read(await fetchClient.GET("/user/info", { signal: context.signal, params: { query: a } })),
    ),
    change("user_create", "Create a user without generating a key", { user_id: optionalText, ...userFields }, (a) =>
      post<"NewUserRequest">("/user/new", { user_id: present(a.user_id), ...userBody(a), auto_create_key: false }),
    ),
    change("user_update", "Update a user", { user_id: text, ...userFields }, (a) =>
      post<"UpdateUserRequest">("/user/update", { user_id: a.user_id, ...userBody(a) }),
    ),
    remove("user_delete", "Delete users", { user_ids: z.array(text).min(1).max(20) }, async (a) =>
      read(await fetchClient.POST("/user/delete", { signal: context.signal, body: a })),
    ),
    tool("budgets_list", "List budgets", { page, page_size: pageSize, search: optionalText }, (a) =>
      apiClient.get<unknown>("/management/v1/budgets", {
        accessToken: context.accessToken,
        signal: context.signal,
        query: { page: a.page, page_size: a.page_size, q: present(a.search) },
      }),
    ),
    tool("budget_info", "View budgets", { budgets: z.array(text).min(1).max(20) }, async (a) =>
      read(await fetchClient.POST("/budget/info", { signal: context.signal, body: a })),
    ),
    change("budget_create", "Create a budget", { budget_id: optionalText, ...budgetFields }, async (a) =>
      read(
        await fetchClient.POST("/budget/new", {
          signal: context.signal,
          body: { budget_id: present(a.budget_id), ...budgetBody(a) },
        }),
      ),
    ),
    change("budget_update", "Update a budget", { budget_id: text, ...budgetFields }, async (a) =>
      read(
        await fetchClient.POST("/budget/update", {
          signal: context.signal,
          body: { budget_id: a.budget_id, ...budgetBody(a) },
        }),
      ),
    ),
    remove("budget_delete", "Delete a budget", { id: text }, async (a) =>
      read(await fetchClient.POST("/budget/delete", { signal: context.signal, body: a })),
    ),
    tool("spend_report", "View spend by date and group (requires an enterprise license)", spendFields, async (a) =>
      read(
        await fetchClient.GET("/global/spend/report", {
          signal: context.signal,
          params: { query: { ...a, team_id: present(a.team_id), internal_user_id: present(a.internal_user_id) } },
        }),
      ),
    ),
    tool(
      "team_spend_report",
      "View team spend (requires an enterprise license)",
      { ...dates, team_id: text },
      async (a) => read(await fetchClient.GET("/team/spend/report", { signal: context.signal, params: { query: a } })),
    ),
    tool(
      "key_spend_report",
      "View virtual key spend (requires an enterprise license)",
      { ...dates, api_key: hash },
      async (a) => read(await fetchClient.GET("/key/spend/report", { signal: context.signal, params: { query: a } })),
    ),
    tool("request_logs", "List operational request logs, excluding prompts and responses", logFields, async (a) =>
      read(
        await fetchClient.GET("/spend/logs/v2", {
          signal: context.signal,
          params: {
            query: {
              ...a,
              team_id: present(a.team_id),
              user_id: present(a.user_id),
              api_key: present(a.api_key),
              request_id: present(a.request_id),
              model: present(a.model),
              status_filter: present(a.status_filter),
            },
          },
        }),
      ),
    ),
  ];
}
