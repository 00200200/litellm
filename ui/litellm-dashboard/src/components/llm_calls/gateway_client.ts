import openai, { type ClientOptions } from "openai";
import { getProxyBaseUrl } from "@/components/networking";
import { getAuthHeaderName } from "@/lib/http/runtime";
import type { CustomHeaders } from "./request_headers";

interface GatewayClientOptions extends Pick<ClientOptions, "maxRetries" | "timeout" | "fetch"> {
  accessToken: string;
  baseURL?: string;
  headers?: CustomHeaders;
}

export const createGatewayClient = ({ accessToken, baseURL, headers, ...options }: GatewayClientOptions) => {
  const authHeader = getAuthHeaderName();
  const clientOptions: ClientOptions = {
    ...options,
    apiKey: accessToken,
    baseURL: baseURL || getProxyBaseUrl(),
    dangerouslyAllowBrowser: true,
    defaultHeaders:
      authHeader.toLowerCase() === "authorization"
        ? headers
        : { Authorization: null, [authHeader]: `Bearer ${accessToken}`, ...headers },
  };
  return new openai.OpenAI(clientOptions);
};
