import { describe, expect, it } from "vitest";
import { generatedKey, projectToolResult } from "./toolResults";

const hash = "a".repeat(64);

describe("LiteAsk model results", () => {
  it("preserves operational log fields and pagination without copying logged payloads", () => {
    const response = {
      data: [
        {
          request_id: "request-1",
          model: "chat-model",
          status: "failure",
          spend: 0.03,
          total_tokens: 30,
          api_key: hash,
          messages: "opaque-prompt-marker",
          response: { content: "opaque-response-marker" },
          proxy_server_request: { headers: { authorization: "opaque-header-marker" } },
          metadata: {
            user_id: "opaque-metadata-marker",
            error_information: { error_message: "opaque-error-marker" },
          },
          api_base: "https://opaque-base-marker.example",
          request_tags: ["opaque-tag-marker"],
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      total_pages: 1,
      total_is_capped: false,
    };
    const result = projectToolResult(response, "request_logs", []);
    const expected = {
      data: [
        {
          request_id: "request-1",
          model: "chat-model",
          status: "failure",
          spend: 0.03,
          total_tokens: 30,
          key_hash: hash,
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      total_pages: 1,
      total_is_capped: false,
    };
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("opaque-");
  });

  it("retains an operable key hash only in documented key and spend response positions", () => {
    expect(
      projectToolResult({ keys: [{ token: hash, key_alias: "shared", team_id: "team-1" }] }, "keys_list", []),
    ).toEqual({ keys: [{ key_hash: hash, key_alias: "shared", team_id: "team-1" }] });
    expect(projectToolResult({ key: hash, info: { token: hash, max_budget: 10 } }, "key_info", [])).toEqual({
      info: { key_hash: hash, max_budget: 10 },
    });
    expect(
      projectToolResult({ token: hash, info: { token_id: hash }, data: [{ api_key: hash }] }, "teams_list", []),
    ).toEqual({ info: {}, data: [{}] });
    expect(
      projectToolResult(
        [{ api_key: hash, total_cost: 1, model_details: [{ model: "chat", total_input_tokens: 20 }] }],
        "key_spend_report",
        [],
      ),
    ).toEqual([{ key_hash: hash, total_cost: 1, model_details: [{ model: "chat", total_input_tokens: 20 }] }]);
  });

  it("keeps generated credentials out even when a custom key is hex and repeated in a scalar or key field", () => {
    const secret = "b".repeat(64);
    const raw = { key: secret, token: secret, key_alias: `copy-${secret}`, models: [secret], team_id: "team-1" };
    expect(generatedKey(raw)).toBe(secret);
    expect(projectToolResult(raw, "key_create", [secret])).toEqual({
      key_alias: "[redacted]",
      models: ["[redacted]"],
      team_id: "team-1",
    });
    expect(projectToolResult({ keys: [{ token: secret, key_alias: secret }] }, "keys_list", [secret])).toEqual({
      keys: [{ key_hash: "[redacted]", key_alias: "[redacted]" }],
    });
  });

  it("preserves budget limits and membership information while dropping arbitrary settings", () => {
    expect(
      projectToolResult(
        {
          team_info: { team_id: "team-1", max_budget: 100, spend: 20, config: { max_budget: 500 } },
          team_memberships: [
            { user_id: "user-1", budget_id: "budget-1", max_budget_in_team: 10, budget_source: "custom" },
          ],
          keys: [{ token: hash, team_id: "team-1" }],
        },
        "team_info",
        [],
      ),
    ).toEqual({
      team_info: { team_id: "team-1", max_budget: 100, spend: 20 },
      team_memberships: [{ user_id: "user-1", budget_id: "budget-1", max_budget_in_team: 10, budget_source: "custom" }],
      keys: [{ key_hash: hash, team_id: "team-1" }],
    });
  });

  it("bounds row counts, nested depth and total serialized output", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ user_id: `user-${index}` }));
    expect(projectToolResult({ users: rows }, "users_list", [])).toMatchObject({
      users: { returned_count: 50, truncated: true },
    });
    const deep = Array.from({ length: 12 }).reduce<unknown>((nested) => ({ data: nested }), { user_id: "unreachable" });
    const limited = JSON.stringify(projectToolResult(deep, "users_list", []));
    expect(limited).toContain('"truncated":true');
    expect(limited).not.toContain("unreachable");
    expect(
      projectToolResult({ users: rows.map((row) => ({ ...row, user_alias: "x".repeat(500) })) }, "users_list", []),
    ).toEqual({ truncated: true, message: "Result too large. Use a smaller page or narrower filter." });
  });

  it("returns no unstructured response text to the model", () => {
    expect(projectToolResult("opaque server response", "key_info", [])).toBeNull();
    expect(generatedKey({ key: "" })).toBeUndefined();
  });
});
