import "openai/shims/web";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { setGlobalLitellmHeaderName, switchToWorkerUrl } from "@/components/networking";
import LiteAskWidget from "./LiteAskWidget";
import { LITEASK_MAX_MESSAGE_LENGTH } from "./agent";

const { transport } = vi.hoisted(() => {
  const transport = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", transport);
  return { transport };
});

vi.unmock("@/app/(dashboard)/hooks/useAuthorized");

const MANAGEMENT = "https://management.test/proxy";
const INFERENCE = "https://management.test/inference";
const EXTERNAL_INFERENCE = "https://inference.test/proxy";
const NEW_KEY = "sk-created-for-widget-test";
const keyArguments = {
  key_alias: "Widget key",
  team_id: "team-1",
  user_id: null,
  models: null,
  max_budget: 40,
  budget_duration: null,
  rpm_limit: null,
  tpm_limit: null,
  budget_id: null,
  duration: null,
};

type RecordedRequest = { url: string; headers: Headers; body: Record<string, unknown> };
type ModelReply = {
  role: "assistant";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const toolReply = (name: string, args: Record<string, unknown>): ModelReply => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "call-test", type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const answer = (content: string): ModelReply => ({ role: "assistant", content });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function session(role = "proxy_admin", user = "first-admin") {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  const claims = {
    key: `sk-session-${user}`,
    user_id: user,
    user_role: role,
    auth_header_name: "X-Gateway-Session",
    exp: Date.now() / 1000 + 3600,
  };
  const token = `${encode({ alg: "none" })}.${encode(claims)}.test`;
  document.cookie = `token=${token}; Path=/`;
  return token;
}

function SessionReady() {
  const { authLoading } = useAuth();
  return <output>{authLoading ? "Session loading" : "Session ready"}</output>;
}

function renderWidget() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <SessionReady />
        <LiteAskWidget />
      </AuthProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()), client };
}

interface GatewayOptions {
  write?: () => Promise<Response>;
  read?: () => Promise<Response>;
  settings?: { target: string; status: number };
}

function gateway(replies: (ModelReply | Promise<ModelReply>)[], options: GatewayOptions = {}) {
  const requests: RecordedRequest[] = [];
  const settings = options.settings ?? { target: INFERENCE, status: 200 };
  transport.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
    const body: Record<string, unknown> = request.method === "GET" ? {} : await request.clone().json();
    requests.push({ url: request.url, headers: request.headers, body });
    const path = new URL(request.url).pathname;
    if (path.endsWith("/litellm-ui-config"))
      return json({ proxy_base_url: MANAGEMENT, server_root_path: "", admin_ui_disabled: false });
    if (path.endsWith("/sso/get/ui_settings"))
      return json({ PROXY_BASE_URL: MANAGEMENT, LITELLM_UI_API_DOC_BASE_URL: settings.target }, settings.status);
    if (path.endsWith("/model_group/info"))
      return json({
        data: [
          { model_group: "a-embedding", mode: "embedding" },
          { model_group: "chat-model", mode: "chat" },
        ],
      });
    if (path.endsWith("/chat/completions")) {
      const message = await replies.shift();
      if (!message) return json({ error: { message: "Model unavailable" } }, 503);
      const completion = {
        id: "completion-test",
        object: "chat.completion",
        created: 0,
        model: "chat-model",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
      };
      return json(completion);
    }
    if (path.endsWith("/team/info"))
      return options.read ? options.read() : json({ team_info: { team_id: "team-1", max_budget: 40 } });
    if (path.endsWith("/key/generate"))
      return options.write ? options.write() : json({ key: NEW_KEY, key_alias: "Widget key" });
    throw new Error(`Unexpected request: ${request.url}`);
  });
  return requests;
}

async function openWidget() {
  fireEvent.click(await screen.findByRole("button", { name: "LiteAsk" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "LiteAsk model" })).toHaveValue("chat-model"));
}

function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Ask LiteAsk…"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

beforeEach(() => {
  transport.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  switchToWorkerUrl(null);
  setGlobalLitellmHeaderName("Authorization");
  session();
});

afterEach(() => {
  document.cookie = "token=; Max-Age=0; Path=/";
});

describe("LiteAsk with the dashboard session and gateway APIs", () => {
  it.each(["proxy_admin_viewer", "internal_user", "internal_user_viewer", "org_admin"])(
    "does not expose admin actions to %s",
    async (role) => {
      session(role);
      const requests = gateway([]);
      const { client } = renderWidget();
      expect(await screen.findByText("Session ready")).toBeInTheDocument();
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(screen.queryByRole("button", { name: "LiteAsk" })).not.toBeInTheDocument();
      expect(requests.every((request) => request.url.endsWith("/litellm-ui-config"))).toBe(true);
    },
  );

  it("uses the existing session header for management reads and the configured inference target", async () => {
    const requests = gateway([toolReply("team_info", { team_id: "team-1" }), answer("The team budget is $40.")]);
    renderWidget();
    await openWidget();
    send("What is the team budget?");
    expect(await screen.findByText("The team budget is $40.")).toBeInTheDocument();
    const read = requests.find((request) => request.url.includes("/team/info"));
    expect(read?.url).toBe(`${MANAGEMENT}/team/info?team_id=team-1&key_limit=50`);
    expect(read?.headers.get("X-Gateway-Session")).toBe("Bearer sk-session-first-admin");
    const completions = requests.filter((request) => request.url.endsWith("/chat/completions"));
    expect(completions).toHaveLength(2);
    expect(completions.every((request) => request.url === `${INFERENCE}/chat/completions`)).toBe(true);
    expect(completions[0].headers.get("X-Gateway-Session")).toBe(read?.headers.get("X-Gateway-Session"));
    expect(completions[0].body.model).toBe("chat-model");
    expect(screen.queryByRole("button", { name: "Use configured gateway" })).not.toBeInTheDocument();
  });

  it("keeps oversized drafts editable and continues after a long assistant reply", async () => {
    const longReply = "a".repeat(LITEASK_MAX_MESSAGE_LENGTH + 1);
    const draft = "b".repeat(LITEASK_MAX_MESSAGE_LENGTH + 1);
    const requests = gateway([answer(longReply), answer("Continued successfully.")]);
    renderWidget();
    await openWidget();
    send("First request");
    expect(await screen.findByText(longReply)).toBeInTheDocument();
    send(draft);
    expect(screen.getByRole("alert")).toHaveTextContent("8,000 characters");
    expect(screen.getByPlaceholderText("Ask LiteAsk…")).toHaveValue(draft);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(within(screen.getByLabelText("LiteAsk conversation")).queryByText(draft)).not.toBeInTheDocument();
    expect(requests.filter((request) => request.url.endsWith("/chat/completions"))).toHaveLength(1);
    send("Shortened request");
    expect(await screen.findByText("Continued successfully.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const completions = requests.filter((request) => request.url.endsWith("/chat/completions"));
    expect(completions).toHaveLength(2);
    expect(completions[1].body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "First request" },
      { role: "assistant", content: longReply.slice(0, LITEASK_MAX_MESSAGE_LENGTH) },
      { role: "user", content: "Shortened request" },
    ]);
  });

  it("requires a choice before sending the session to another origin and renews it after target or account changes", async () => {
    const settings = { target: EXTERNAL_INFERENCE, status: 200 };
    const requests = gateway([answer("Connected.")], { settings });
    const view = renderWidget();
    fireEvent.click(await screen.findByRole("button", { name: "LiteAsk" }));
    expect(await screen.findByText(EXTERNAL_INFERENCE)).toBeInTheDocument();
    expect(screen.getByText(/send your existing session credential/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask LiteAsk…")).not.toBeInTheDocument();
    expect(requests.some((request) => request.url.endsWith("/chat/completions"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Use configured gateway" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "LiteAsk model" })).toHaveValue("chat-model"));
    send("Hello");
    expect(await screen.findByText("Connected.")).toBeInTheDocument();
    const completion = requests.find((request) => request.url.endsWith("/chat/completions"));
    expect(completion?.url).toBe(`${EXTERNAL_INFERENCE}/chat/completions`);
    expect(completion?.headers.get("X-Gateway-Session")).toBe("Bearer sk-session-first-admin");

    settings.target = "https://another-inference.test/new-root";
    await act(async () => view.client.invalidateQueries({ queryKey: ["proxySettings"] }));
    expect(await screen.findByText(settings.target)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask LiteAsk…")).not.toBeInTheDocument();
    expect(screen.queryByText("Connected.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use configured gateway" }));
    expect(await screen.findByPlaceholderText("Ask LiteAsk…")).toBeEnabled();

    session("proxy_admin", "second-admin");
    view.refresh();
    fireEvent.click(await screen.findByRole("button", { name: "LiteAsk" }));
    expect(await screen.findByRole("button", { name: "Use configured gateway" })).toBeEnabled();
    expect(screen.queryByPlaceholderText("Ask LiteAsk…")).not.toBeInTheDocument();
    expect(requests.filter((request) => request.url.endsWith("/chat/completions"))).toHaveLength(1);
  });

  it.each(["model", "read"])(
    "blocks an old %s continuation after the configured destination changes",
    async (stage) => {
      const modelResponse = deferred<ModelReply>();
      const readResponse = deferred<Response>();
      const settings = { target: INFERENCE, status: 200 };
      const proposal = toolReply("team_info", { team_id: "team-1" });
      const requests = gateway([stage === "model" ? modelResponse.promise : proposal, answer("Stale answer.")], {
        settings,
        read: () => readResponse.promise,
      });
      const view = renderWidget();
      await openWidget();
      send("Read this team");
      const pendingPath = stage === "model" ? "/chat/completions" : "/team/info";
      await waitFor(() => expect(requests.some((request) => request.url.includes(pendingPath))).toBe(true));
      settings.target = EXTERNAL_INFERENCE;
      await act(async () => view.client.invalidateQueries({ queryKey: ["proxySettings"] }));
      expect(await screen.findByRole("button", { name: "Use configured gateway" })).toBeEnabled();
      await act(async () => {
        modelResponse.resolve(proposal);
        readResponse.resolve(json({ team_info: { team_id: "team-1", max_budget: 40 } }));
      });
      expect(requests.filter((request) => request.url.endsWith("/chat/completions"))).toHaveLength(1);
      expect(requests.filter((request) => request.url.includes("/team/info"))).toHaveLength(stage === "model" ? 0 : 1);
      expect(screen.queryByText("Stale answer.")).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Ask LiteAsk…")).not.toBeInTheDocument();
    },
  );

  it("blocks an invalid configured recipient without falling back to management inference", async () => {
    const settings = { target: "https://user:secret@inference.test/proxy", status: 200 };
    const requests = gateway([], { settings });
    renderWidget();
    fireEvent.click(await screen.findByRole("button", { name: "LiteAsk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("without credentials");
    expect(screen.queryByText(settings.target)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use configured gateway" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask LiteAsk…")).not.toBeInTheDocument();
    expect(requests.some((request) => request.url.endsWith("/chat/completions"))).toBe(false);
  });

  it("sends a reviewed write once, keeps it running when closed, and keeps its generated key out of model history", async () => {
    const response = deferred<Response>();
    const requests = gateway(
      [toolReply("key_create", keyArguments), answer("Created the key."), answer("You are welcome.")],
      { write: () => response.promise },
    );
    renderWidget();
    await openWidget();
    send("Create a team key with a $40 budget");
    const conversation = screen.getByLabelText("LiteAsk conversation");
    const review = await within(conversation).findByRole("region", { name: "Create a virtual key" });
    expect(review).toHaveFocus();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(review).toHaveTextContent('"team_id": "team-1"');
    expect(review).toHaveTextContent('"max_budget": 40');
    expect(requests.filter((request) => request.url.endsWith("/key/generate"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "LiteAsk" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "LiteAsk" }));
    const reopenedReview = await screen.findByRole("region", { name: "Create a virtual key" });
    await waitFor(() => expect(reopenedReview).toHaveFocus());
    const confirm = within(reopenedReview).getByRole("button", { name: "Confirm change" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByText("Applying change…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "LiteAsk" }));
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    await act(async () => response.resolve(json({ key: NEW_KEY, key_alias: "Widget key" })));
    expect(await screen.findByText("Created the key.")).toBeInTheDocument();
    expect(screen.getByText(NEW_KEY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Create a virtual key" })).toBeInTheDocument();
    const writes = requests.filter((request) => request.url.endsWith("/key/generate"));
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ key_alias: "Widget key", team_id: "team-1", max_budget: 40 });
    send("Thanks");
    expect(await screen.findByText("You are welcome.")).toBeInTheDocument();
    expect(JSON.stringify(requests.filter((request) => request.url.endsWith("/chat/completions")))).not.toContain(
      NEW_KEY,
    );
    expect(localStorage.length).toBe(0);
  });

  it("cancels a pending review without a write and releases the turn for the next message", async () => {
    const requests = gateway([toolReply("key_create", keyArguments), answer("No change was made.")]);
    renderWidget();
    await openWidget();
    send("Create a key");
    const review = await screen.findByRole("region", { name: "Create a virtual key" });
    fireEvent.click(within(review).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Ask LiteAsk…")).toBeEnabled());
    send("What happened?");
    expect(await screen.findByText("No change was made.")).toBeInTheDocument();
    expect(requests.filter((request) => request.url.endsWith("/key/generate"))).toHaveLength(0);
  });

  it("discards the previous account's pending review and conversation", async () => {
    const requests = gateway([toolReply("key_create", keyArguments), answer("Fresh session.")]);
    const view = renderWidget();
    await openWidget();
    send("Old account request");
    expect(await screen.findByRole("region", { name: "Create a virtual key" })).toBeInTheDocument();
    session("proxy_admin", "second-admin");
    view.refresh();
    expect(screen.queryByRole("region", { name: "Create a virtual key" })).not.toBeInTheDocument();
    await openWidget();
    expect(screen.queryByText("Old account request")).not.toBeInTheDocument();
    send("New account request");
    expect(await screen.findByText("Fresh session.")).toBeInTheDocument();
    expect(requests.filter((request) => request.url.endsWith("/key/generate"))).toHaveLength(0);
  });

  it.each(["New chat", "target change"])("cancels an inline pending review on %s", async (transition) => {
    const settings = { target: INFERENCE, status: 200 };
    const requests = gateway([toolReply("key_create", keyArguments), answer("Fresh conversation.")], { settings });
    const { client } = renderWidget();
    await openWidget();
    send("Old pending request");
    expect(await screen.findByRole("region", { name: "Create a virtual key" })).toBeInTheDocument();
    if (transition === "New chat") {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    } else {
      settings.target = `${INFERENCE}/updated`;
      await act(async () => client.invalidateQueries({ queryKey: ["proxySettings"] }));
    }
    await waitFor(() => expect(screen.queryByRole("region", { name: "Create a virtual key" })).not.toBeInTheDocument());
    expect(screen.queryByText("Old pending request")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText("Ask LiteAsk…")).toBeEnabled());
    send("New request");
    expect(await screen.findByText("Fresh conversation.")).toBeInTheDocument();
    expect(requests.filter((request) => request.url.endsWith("/key/generate"))).toHaveLength(0);
  });

  it.each(["initial", "refresh"])("blocks inference after a settings failure during %s", async (stage) => {
    const settings = { target: INFERENCE, status: stage === "initial" ? 503 : 200 };
    const requests = gateway([], { settings });
    const { client } = renderWidget();
    fireEvent.click(await screen.findByRole("button", { name: "LiteAsk" }));
    if (stage === "refresh") {
      expect(await screen.findByPlaceholderText("Ask LiteAsk…")).toBeEnabled();
      settings.status = 503;
      await act(async () => client.invalidateQueries({ queryKey: ["proxySettings"] }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load gateway settings.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByPlaceholderText("Ask LiteAsk…")).not.toBeInTheDocument();
    expect(requests.some((request) => request.url.endsWith("/chat/completions"))).toBe(false);
  });

  it("retains a confirmed success when the following model request fails", async () => {
    gateway([toolReply("key_create", keyArguments)]);
    renderWidget();
    await openWidget();
    send("Create a key");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm change" }));
    expect(await screen.findByText("Completed: Create a virtual key")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Completed changes are shown above.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("may have completed");
  });

  it("reports an uncertain write failure without retrying the change", async () => {
    const requests = gateway([toolReply("key_create", keyArguments)], {
      write: async () => json({ error: "Connection lost" }, 502),
    });
    renderWidget();
    await openWidget();
    send("Create a key");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A submitted change may have completed.");
    expect(requests.filter((request) => request.url.endsWith("/key/generate"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
  });
});
