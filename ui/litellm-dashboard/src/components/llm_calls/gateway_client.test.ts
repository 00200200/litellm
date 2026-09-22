import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuthHeaderNameGetter } from "@/lib/http/runtime";
import { createGatewayClient } from "./gateway_client";

vi.mock("@/components/networking", () => ({
  getProxyBaseUrl: () => "https://management.example/proxy",
}));

afterEach(() => registerAuthHeaderNameGetter(() => "Authorization"));

const transport = () => vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));

describe("gateway inference client", () => {
  it("uses the configured inference origin and root path with the signed-in token", async () => {
    const fetchImpl = transport();
    const client = createGatewayClient({
      accessToken: "session-token",
      baseURL: "https://gateway.example/root/v1/",
      fetch: fetchImpl,
    });

    await client.chat.completions.create({ model: "model", messages: [] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://gateway.example/root/v1/chat/completions");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
  });

  it("uses the shared proxy base when no inference override is supplied", async () => {
    const fetchImpl = transport();
    const client = createGatewayClient({ accessToken: "token", fetch: fetchImpl });

    await client.chat.completions.create({ model: "model", messages: [] });

    expect(fetchImpl.mock.calls[0][0]).toBe("https://management.example/proxy/chat/completions");
  });

  it("sends a custom session header without duplicating the token in Authorization", async () => {
    registerAuthHeaderNameGetter(() => "x-gateway-key");
    const fetchImpl = transport();
    const client = createGatewayClient({ accessToken: "token", fetch: fetchImpl });

    await client.chat.completions.create({ model: "model", messages: [] });

    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get("x-gateway-key")).toBe("Bearer token");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("preserves Playground's explicit passthrough and provider headers", async () => {
    registerAuthHeaderNameGetter(() => "x-gateway-key");
    const fetchImpl = transport();
    const client = createGatewayClient({
      accessToken: "token",
      fetch: fetchImpl,
      headers: { authorization: "Bearer provider-token", "anthropic-beta": "feature", "x-litellm-tags": "test" },
    });

    await client.chat.completions.create({ model: "model", messages: [] });

    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer provider-token");
    expect(headers.get("x-gateway-key")).toBe("Bearer token");
    expect(headers.get("anthropic-beta")).toBe("feature");
    expect(headers.get("x-litellm-tags")).toBe("test");
  });
});
