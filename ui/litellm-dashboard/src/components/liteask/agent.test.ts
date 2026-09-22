import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { createGatewayClient } from "@/components/llm_calls/gateway_client";
import { registerAuthHeaderNameGetter } from "@/lib/http/runtime";
import { LITEASK_MAX_MESSAGE_LENGTH, resolveInferenceTarget, runLiteAsk } from "./agent";
import type { LiteAskConfirmation } from "./tools";

const { get, post, typedPost } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), typedPost: vi.fn() }));
vi.mock("@/components/networking", () => ({
  getProxyBaseUrl: () => "https://management.example",
  apiClient: { post },
}));
vi.mock("@/lib/http/api", () => ({ fetchClient: { GET: get, POST: typedPost } }));

const teamsArgs = { page: 1, page_size: 20, search: null, organization_id: null };
const keyArgs = {
  key_alias: "New key",
  team_id: "team-1",
  user_id: null,
  models: null,
  max_budget: 100,
  budget_duration: "1mo",
  rpm_limit: null,
  tpm_limit: null,
  budget_id: null,
  duration: null,
};
const toolCall = (name: string, args: unknown, id = "call-1") => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (calls: ReturnType<typeof toolCall>[] = []): ChatCompletion => ({
  id: "completion",
  object: "chat.completion",
  created: 0,
  model: "selected-model",
  choices: [
    {
      index: 0,
      logprobs: null,
      finish_reason: calls.length ? "tool_calls" : "stop",
      message: { role: "assistant", refusal: null, content: calls.length ? null : "Done", tool_calls: calls },
    },
  ],
});

function transport(responses: ChatCompletion[], status: number | readonly number[] = 200) {
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as ChatCompletionCreateParamsNonStreaming);
    const response = responses[requests.length - 1];
    if (!response) throw new Error("Unexpected model request");
    return new Response(JSON.stringify(response), {
      status: typeof status === "number" ? status : status[requests.length - 1],
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    requests,
    fetchImpl,
    client: createGatewayClient({ accessToken: "test-session", baseURL: "https://gateway.example", fetch: fetchImpl }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const options = () => ({
  model: "selected-model",
  accessToken: "test-session",
  inferenceBaseUrl: "https://gateway.example",
  messages: [{ role: "user" as const, content: "Check the team budget" }],
  signal: new AbortController().signal,
  assertCurrent: vi.fn(),
  confirm: vi.fn(async (_proposal: LiteAskConfirmation) => true),
  onGeneratedKey: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: { teams: [{ team_id: "team-1", team_alias: "Engineering", max_budget: 100 }] } });
  post.mockResolvedValue({ team_id: "team-1" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  registerAuthHeaderNameGetter(() => "Authorization");
});

describe("inference destination", () => {
  it.each([
    ["", "", "https://proxy.example/ui/settings", ["https://proxy.example/", false]],
    ["", "/root", "https://proxy.example/ui/settings", ["https://proxy.example/root", false]],
    ["v1", "/root", "https://proxy.example/ui/settings", ["https://proxy.example/v1", false]],
    ["/root/v1/", "/root", "https://proxy.example/ui/settings", ["https://proxy.example/root/v1/", false]],
    ["https://PROXY.example:443/v1", "/root", "https://proxy.example/ui/", ["https://proxy.example/v1", false]],
    ["https://models.example/v1", "/root", "https://proxy.example/ui/", ["https://models.example/v1", true]],
    ["//models.example/v1", "/root", "https://proxy.example/ui/", ["https://models.example/v1", true]],
    ["http://localhost:4001", "http://localhost:4000", "http://localhost:3000/ui", ["http://localhost:4001/", true]],
    ["", "https://management.example/root", "https://ui.example/ui", ["https://management.example/root", false]],
  ] as const)(
    "resolves %s against the page origin and compares the management origin",
    (candidate, management, page, [baseUrl, requiresConsent]) => {
      expect(resolveInferenceTarget(candidate, management, page)).toEqual({ baseUrl, requiresConsent, error: null });
    },
  );

  it.each([
    ["https://", "https://proxy.example"],
    ["javascript:alert(1)", "https://proxy.example"],
    ["https://user:secret@models.example", "https://proxy.example"],
    ["https://models.example?token=secret", "https://proxy.example"],
    ["https://models.example#secret", "https://proxy.example"],
    ["https://models.example?", "https://proxy.example"],
    ["https://models.example#", "https://proxy.example"],
    ["https://models.example", "https://"],
    ["https://models.example", "ftp://proxy.example"],
    ["https://models.example", "https://user:secret@proxy.example"],
    ["https://models.example", "https://proxy.example?secret"],
    ["https://models.example", "https://proxy.example#secret"],
  ])("rejects invalid target or management configuration without exposing credentials", (candidate, management) => {
    const result = resolveInferenceTarget(candidate, management, "https://ui.example/ui/");
    expect(result).toMatchObject({ baseUrl: null, requiresConsent: false, error: expect.any(String) });
    expect(result.error).not.toContain("secret");
  });

  it.each([
    ["https://ui.example/ui/", "http://proxy.example"],
    ["http://ui.example/ui/", "https://proxy.example"],
  ])("rejects a downgrade from either HTTPS boundary", (page, management) => {
    expect(resolveInferenceTarget("http://models.example", management, page)).toMatchObject({
      baseUrl: null,
      requiresConsent: false,
      error: expect.stringContaining("HTTPS"),
    });
  });
});

describe("LiteAsk SDK tool runner", () => {
  it("accepts a user message at the limit and rejects one beyond it before inference", async () => {
    const input = options();
    const model = transport([completion()]);
    await expect(
      runLiteAsk(
        { ...input, messages: [{ role: "user", content: "a".repeat(LITEASK_MAX_MESSAGE_LENGTH) }] },
        model.client,
      ),
    ).resolves.toBe("Done");
    await expect(
      runLiteAsk(
        { ...input, messages: [{ role: "user", content: "a".repeat(LITEASK_MAX_MESSAGE_LENGTH + 1) }] },
        model.client,
      ),
    ).rejects.toThrow("characters");
    expect(model.requests).toHaveLength(1);
  });

  it.each(["Authorization", "x-gateway-key"])(
    "forbids redirects on production inference requests using %s",
    async (authHeader) => {
      registerAuthHeaderNameGetter(() => authHeader);
      const model = transport([completion([toolCall("teams_list", teamsArgs)]), completion()]);
      vi.stubGlobal("fetch", model.fetchImpl);

      await expect(runLiteAsk(options())).resolves.toBe("Done");

      expect(model.fetchImpl).toHaveBeenCalledTimes(2);
      for (const [url, init] of model.fetchImpl.mock.calls) {
        expect(url).toBe("https://gateway.example/chat/completions");
        expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
        expect(new Headers(init?.headers).get(authHeader)).toBe("Bearer test-session");
      }
    },
  );

  it("rechecks the current scope before a later production SDK fetch even without a tool callback", async () => {
    const model = transport([completion([toolCall("unknown_tool", {})]), completion()]);
    const input = options();
    const send = model.fetchImpl.getMockImplementation()!;
    model.fetchImpl.mockImplementationOnce(async (url, init) => {
      const response = await send(url, init);
      input.assertCurrent.mockImplementation(() => {
        throw new Error("Session changed");
      });
      return response;
    });
    vi.stubGlobal("fetch", model.fetchImpl);

    await expect(runLiteAsk(input)).rejects.toBeInstanceOf(Error);

    expect(model.fetchImpl).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("runs a real multi-step SDK conversation using projected management results", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2037-04-05T00:30:00.000Z"));
    const model = transport([completion([toolCall("teams_list", teamsArgs)]), completion()]);
    const input = options();

    await expect(runLiteAsk(input, model.client)).resolves.toBe("Done");

    expect(get).toHaveBeenCalledWith("/v2/team/list", expect.objectContaining({ signal: input.signal }));
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining(`Current UTC date: ${new Date().toISOString().slice(0, 10)}`),
    });
    expect(model.requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: JSON.stringify({
        operation: "teams_list",
        success: true,
        result: { teams: [{ team_id: "team-1", team_alias: "Engineering", max_budget: 100 }] },
      }),
    });
    expect(input.confirm).not.toHaveBeenCalled();
  });

  it("waits for the exact write review and keeps generated keys out of model requests", async () => {
    const model = transport([completion([toolCall("key_create", keyArgs)]), completion()]);
    const approval = deferred<boolean>();
    const proposed = deferred<void>();
    const input = options();
    input.confirm.mockImplementation(async () => {
      proposed.resolve();
      return approval.promise;
    });
    post.mockResolvedValue({ key: "sk-generated-private", key_alias: "New key", metadata: { secret: "hidden" } });

    const result = runLiteAsk(input, model.client);
    await proposed.promise;
    expect(post).not.toHaveBeenCalled();
    expect(input.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "key_create",
        arguments: { key_alias: "New key", team_id: "team-1", max_budget: 100, budget_duration: "1mo" },
      }),
    );
    approval.resolve(true);
    await expect(result).resolves.toBe("Done");

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/key/generate",
      expect.objectContaining({
        accessToken: "test-session",
        body: expect.objectContaining({ key_alias: "New key", team_id: "team-1", max_budget: 100 }),
        signal: input.signal,
      }),
    );
    expect(input.onGeneratedKey).toHaveBeenCalledWith({ key: "sk-generated-private", label: "Create a virtual key" });
    expect(JSON.stringify(model.requests)).not.toContain("sk-generated-private");
    expect(JSON.stringify(model.requests)).not.toContain("hidden");
  });

  it("moves a key to a team without clearing its existing policy fields", async () => {
    const key = "a".repeat(64);
    const args = { ...keyArgs, key, key_alias: null, team_id: "new-team", max_budget: null, budget_duration: null };
    const model = transport([completion([toolCall("key_update", args)]), completion()]);

    await expect(runLiteAsk(options(), model.client)).resolves.toBe("Done");

    expect(post.mock.calls[0][0]).toBe("/key/update");
    expect(JSON.parse(JSON.stringify(post.mock.calls[0][1].body))).toEqual({ key, team_id: "new-team" });
  });

  it("looks up a budget through its read-only POST endpoint without confirmation", async () => {
    const model = transport([completion([toolCall("budget_info", { budgets: ["budget-1"] })]), completion()]);
    const input = options();
    typedPost.mockResolvedValueOnce({ data: [{ budget_id: "budget-1", max_budget: 100 }] });

    await expect(runLiteAsk(input, model.client)).resolves.toBe("Done");

    expect(typedPost).toHaveBeenCalledWith(
      "/budget/info",
      expect.objectContaining({ body: { budgets: ["budget-1"] } }),
    );
    expect(input.confirm).not.toHaveBeenCalled();
    expect(model.requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      content: JSON.stringify({
        operation: "budget_info",
        success: true,
        result: [{ budget_id: "budget-1", max_budget: 100 }],
      }),
    });
  });

  it("preserves a confirmed write's completion when the final model request fails", async () => {
    const model = transport([completion([toolCall("key_create", keyArgs)]), completion()], [200, 500]);
    const input = { ...options(), onMutationSuccess: vi.fn() };
    post.mockResolvedValue({ key: "sk-generated-private", key_alias: "New key" });

    await expect(runLiteAsk(input, model.client)).rejects.toBeInstanceOf(Error);

    expect(input.onMutationSuccess).toHaveBeenCalledExactlyOnceWith({
      name: "key_create",
      title: "Create a virtual key",
    });
    expect(input.onGeneratedKey).toHaveBeenCalledExactlyOnceWith({
      key: "sk-generated-private",
      label: "Create a virtual key",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests)).not.toContain("sk-generated-private");
  });

  it("does not dispatch or continue inference when a pending review is cancelled", async () => {
    const model = transport([completion([toolCall("key_create", keyArgs)]), completion()]);
    const controller = new AbortController();
    const approval = deferred<boolean>();
    const proposed = deferred<void>();
    const input = { ...options(), signal: controller.signal };
    input.confirm.mockImplementation(async () => {
      proposed.resolve();
      return approval.promise;
    });

    const result = runLiteAsk(input, model.client);
    const rejected = expect(result).rejects.toBeInstanceOf(Error);
    await proposed.promise;
    controller.abort();
    approval.resolve(true);
    await rejected;

    expect(post).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
    expect(input.onGeneratedKey).not.toHaveBeenCalled();
  });

  it("rechecks the signed-in scope after approval before dispatch", async () => {
    const model = transport([completion([toolCall("key_create", keyArgs)]), completion()]);
    const input = options();
    input.confirm.mockImplementation(async () => {
      input.assertCurrent.mockImplementation(() => {
        throw new Error("Session changed");
      });
      return true;
    });

    await expect(runLiteAsk(input, model.client)).rejects.toThrow("Session changed");

    expect(post).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
  });

  it("stops when the signed-in scope changes while a lookup is in flight", async () => {
    const model = transport([completion([toolCall("teams_list", teamsArgs)]), completion()]);
    const input = options();
    get.mockImplementationOnce(async () => {
      input.assertCurrent.mockImplementation(() => {
        throw new Error("Session changed");
      });
      return { data: { teams: [{ team_alias: "Previous account data" }] } };
    });

    await expect(runLiteAsk(input, model.client)).rejects.toThrow("Session changed");

    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests)).not.toContain("Previous account data");
  });

  it("gives each sequential action a distinct review without reusing an earlier approval", async () => {
    const model = transport([
      completion([
        toolCall("key_create", keyArgs, "first"),
        toolCall("key_create", { ...keyArgs, key_alias: "Second key" }, "second"),
      ]),
    ]);
    const ready = [deferred<void>(), deferred<void>()];
    const approvals = [deferred<boolean>(), deferred<boolean>()];
    const input = options();
    input.confirm.mockImplementationOnce(async () => {
      ready[0].resolve();
      return approvals[0].promise;
    });
    input.confirm.mockImplementationOnce(async () => {
      ready[1].resolve();
      return approvals[1].promise;
    });

    const result = runLiteAsk(input, model.client);
    const rejected = expect(result).rejects.toThrow("Action cancelled");
    await ready[0].promise;
    approvals[0].resolve(true);
    await ready[1].promise;
    expect(post).toHaveBeenCalledTimes(1);
    expect(input.confirm.mock.calls[0][0].id).not.toBe(input.confirm.mock.calls[1][0].id);
    approvals[0].resolve(true);
    approvals[1].resolve(false);
    await rejected;

    expect(post).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(1);
  });

  it("rejects unknown tools and invalid arguments without invoking management APIs", async () => {
    const model = transport([
      completion([
        toolCall("arbitrary_http_request", { path: "/key/generate" }, "unknown"),
        toolCall("teams_list", { ...teamsArgs, page_size: 10_000 }, "invalid"),
      ]),
      completion(),
    ]);

    await expect(runLiteAsk(options(), model.client)).resolves.toBe("Done");

    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(2);
  });

  it.each(["teams_list", "key_create"])(
    "reports the model step limit after %s without claiming unfinished work is complete",
    async (name) => {
      const args = name === "teams_list" ? teamsArgs : keyArgs;
      const model = transport(Array.from({ length: 6 }, () => completion([toolCall(name, args)])));
      const input = { ...options(), onMutationSuccess: vi.fn() };

      await expect(runLiteAsk(input, model.client)).resolves.toBe(
        "I reached the step limit. Any completed actions remain applied; check the relevant page before continuing.",
      );

      expect(model.requests).toHaveLength(6);
      expect(get).toHaveBeenCalledTimes(name === "teams_list" ? 6 : 0);
      expect(post).toHaveBeenCalledTimes(name === "key_create" ? 6 : 0);
      expect(input.confirm).toHaveBeenCalledTimes(name === "key_create" ? 6 : 0);
      expect(input.onMutationSuccess).toHaveBeenCalledTimes(name === "key_create" ? 6 : 0);
    },
  );

  it("allows twelve actions and a final model answer", async () => {
    const model = transport([
      completion(Array.from({ length: 12 }, (_, index) => toolCall("teams_list", teamsArgs, String(index)))),
      completion(),
    ]);

    await expect(runLiteAsk(options(), model.client)).resolves.toBe("Done");

    expect(get).toHaveBeenCalledTimes(12);
    expect(model.requests).toHaveLength(2);
  });

  it("limits tool invocations even when one model completion proposes many reads", async () => {
    const model = transport([
      completion(Array.from({ length: 13 }, (_, index) => toolCall("teams_list", teamsArgs, String(index)))),
    ]);

    await expect(runLiteAsk(options(), model.client)).rejects.toThrow("action limit");

    expect(get).toHaveBeenCalledTimes(12);
    expect(model.requests).toHaveLength(1);
  });

  it.each(["successful", "failed"])(
    "counts %s lookups across model completions before reviewing a thirteenth action",
    async (outcome) => {
      if (outcome === "failed") get.mockRejectedValue(new Error("Gateway unavailable"));
      const model = transport([
        ...Array.from({ length: 4 }, (_, round) =>
          completion(Array.from({ length: 3 }, (_, index) => toolCall("teams_list", teamsArgs, `${round}-${index}`))),
        ),
        completion([toolCall("key_create", keyArgs)]),
      ]);
      const input = options();

      await expect(runLiteAsk(input, model.client)).rejects.toThrow("action limit");

      expect(get).toHaveBeenCalledTimes(12);
      expect(model.requests).toHaveLength(5);
      expect(input.confirm).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("counts SDK rejections toward the action limit before dispatching a valid tool", async () => {
    const model = transport([
      completion([
        ...Array.from({ length: 6 }, (_, index) => toolCall("unknown_tool", {}, `unknown-${index}`)),
        ...Array.from({ length: 6 }, (_, index) =>
          toolCall("teams_list", { ...teamsArgs, page_size: 10_000 }, `invalid-${index}`),
        ),
        toolCall("key_create", keyArgs, "valid"),
      ]),
    ]);
    const input = options();

    await expect(runLiteAsk(input, model.client)).rejects.toThrow("action limit");

    expect(model.requests).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
    expect(input.confirm).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not retry model transport errors automatically", async () => {
    const model = transport([completion(), completion()], 500);

    await expect(runLiteAsk(options(), model.client)).rejects.toBeInstanceOf(Error);

    expect(model.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
