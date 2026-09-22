"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { useProxySettingsQuery } from "@/app/(dashboard)/hooks/proxySettings/useProxySettings";
import { ChatComposer } from "@/app/(dashboard)/playground/components/chat_ui/ChatComposer";
import ChatMessages from "@/components/chat/ChatMessages";
import type { ChatMessage } from "@/components/chat/types";
import { EndpointType, isModeCompatibleWithEndpoint } from "@/components/chat_ui/mode_endpoint_mapping";
import { fetchAvailableModels, type ModelGroup } from "@/components/llm_calls/fetch_models";
import { getProxyBaseUrl } from "@/components/networking";
import CopyButton from "@/components/shared/CopyButton";
import { SearchSelect } from "@/components/shared/SearchSelect";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { extractProxyErrorMessage } from "@/lib/http/client";
import { getCookie } from "@/utils/cookieUtils";
import { checkTokenValidity } from "@/utils/jwtUtils";
import { isProxyAdminRole } from "@/utils/roles";
import { LITEASK_MAX_MESSAGE_LENGTH, resolveInferenceTarget, runLiteAsk } from "./agent";
import type { LiteAskConfirmation, LiteAskGeneratedKey } from "./tools";

const KEY_QUERIES = ["keys", "infiniteKeys", "deletedKeys", "infiniteKeyAliases"];
const TEAM_QUERIES = ["teams", "teamsTable", "infiniteTeams", "deletedTeams"];
const MUTATION_QUERIES: Record<string, string[]> = {
  key: KEY_QUERIES,
  team: [...TEAM_QUERIES, ...KEY_QUERIES],
  user: ["users", "userList", "infiniteUsers", "userLookup", ...TEAM_QUERIES, ...KEY_QUERIES],
  budget: ["budgets"],
};

type MutationOutcome = "none" | "submitted" | "completed";
const FAILURE_CONTEXT: Readonly<Record<MutationOutcome, string>> = {
  none: "",
  submitted: "A submitted change may have completed. Check the relevant page before trying again. ",
  completed: "Completed changes are shown above. LiteAsk could not finish the response. ",
};

export default function LiteAskWidget() {
  const auth = useAuthorized();
  const sessionReady = !auth.isLoading && auth.isAuthorized;
  const writableAdmin = !auth.isViewOnly && isProxyAdminRole(auth.userRole);
  const allowed = sessionReady && writableAdmin;
  if (!allowed || !auth.token || !auth.accessToken) return null;
  const managementBaseUrl = getProxyBaseUrl();
  return (
    <ConfiguredLiteAsk
      key={JSON.stringify([auth.userId, auth.token, auth.accessToken, managementBaseUrl])}
      token={auth.token}
      accessToken={auth.accessToken}
      managementBaseUrl={managementBaseUrl}
    />
  );
}

function ConfiguredLiteAsk(props: Pick<SessionProps, "token" | "accessToken" | "managementBaseUrl">) {
  const [open, setOpen] = useState(false);
  const settings = useProxySettingsQuery(props.accessToken);
  const candidate =
    settings.data?.LITELLM_UI_API_DOC_BASE_URL?.trim() ||
    settings.data?.PROXY_BASE_URL?.trim() ||
    props.managementBaseUrl;
  const target =
    settings.isSuccess && settings.data
      ? resolveInferenceTarget(candidate, props.managementBaseUrl, window.location.href)
      : null;

  return (
    <LiteAskSession
      key={target?.baseUrl}
      {...props}
      target={target}
      settingsPending={settings.isPending}
      retrySettings={() => void settings.refetch()}
      open={open}
      setOpen={setOpen}
    />
  );
}

interface SessionProps {
  token: string;
  accessToken: string;
  managementBaseUrl: string;
  target: ReturnType<typeof resolveInferenceTarget> | null;
  settingsPending: boolean;
  retrySettings: () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

function LiteAskSession({
  token,
  accessToken,
  managementBaseUrl,
  target,
  settingsPending,
  retrySettings,
  open,
  setOpen,
}: SessionProps) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationOutcome, setMutationOutcome] = useState<MutationOutcome>("none");
  const [generatedKeys, setGeneratedKeys] = useState<LiteAskGeneratedKey[]>([]);
  const [completed, setCompleted] = useState<string[]>([]);
  const [pending, setPending] = useState<LiteAskConfirmation | null>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const active = useRef<AbortController | null>(null);
  const writeActive = useRef(false);
  const approval = useRef<((accepted: boolean) => void) | null>(null);
  const inferenceBaseUrl = target?.baseUrl ?? null;
  const needsConsent = target?.requiresConsent === true && !approved;
  const ready = inferenceBaseUrl !== null && !needsConsent;
  const modelQuery = {
    queryKey: ["liteask-models", token, accessToken, managementBaseUrl],
    queryFn: () => fetchAvailableModels(accessToken),
    enabled: open && ready,
    select: (available: ModelGroup[]) =>
      available.filter((item) => isModeCompatibleWithEndpoint(item.mode, EndpointType.CHAT)),
  };
  const models = useQuery(modelQuery);
  const selectedModel = model ?? models.data?.[0]?.model_group ?? null;
  const noChatModels = models.isSuccess && models.data.length === 0;
  const inputTooLong = input.trim().length > LITEASK_MAX_MESSAGE_LENGTH;

  useLayoutEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  const answerReview = (accepted: boolean) => {
    const respond = approval.current;
    approval.current = null;
    setPending(null);
    respond?.(accepted);
  };

  const reset = () => {
    if (writeActive.current) return;
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setMessages([]);
    setGeneratedKeys([]);
    setCompleted([]);
    setError(null);
    setMutationOutcome("none");
    setInput("");
  };

  const send = async () => {
    if (inputTooLong) return;
    const inputReady = ready && !active.current && input.trim().length > 0;
    if (!inputReady || !selectedModel || !inferenceBaseUrl) return;
    const controller = new AbortController();
    active.current = controller;
    const history: ChatMessage[] = [
      ...messages,
      { id: crypto.randomUUID(), role: "user", content: input.trim(), timestamp: Date.now() },
    ];
    setMessages(history);
    setInput("");
    setError(null);
    setMutationOutcome("none");
    setBusy(true);
    const assertCurrent = () => {
      const sessionValid = getCookie("token") === token && checkTokenValidity(token);
      const gatewayCurrent = getProxyBaseUrl() === managementBaseUrl;
      if (controller.signal.aborted || !sessionValid || !gatewayCurrent) {
        throw new DOMException("Session changed", "AbortError");
      }
    };
    try {
      const request: Parameters<typeof runLiteAsk>[0] = {
        model: selectedModel,
        messages: history,
        accessToken,
        inferenceBaseUrl,
        signal: controller.signal,
        assertCurrent,
        confirm: (request) =>
          new Promise<boolean>((resolve) => {
            assertCurrent();
            const cancel = () => answerReview(false);
            approval.current = (accepted) => {
              controller.signal.removeEventListener("abort", cancel);
              if (accepted) {
                writeActive.current = true;
                setWriting(true);
              } else controller.abort();
              resolve(accepted);
            };
            controller.signal.addEventListener("abort", cancel, { once: true });
            setPending(request);
          }),
        onGeneratedKey: (key) => {
          assertCurrent();
          setGeneratedKeys((current) => [...current, key]);
        },
        onMutationState: (value) => {
          if (value) setMutationOutcome("submitted");
          writeActive.current = value;
          setWriting(value);
        },
        onMutationSuccess: (operation) => {
          setMutationOutcome("completed");
          setCompleted((current) => [...current, operation.title]);
          const scopes = MUTATION_QUERIES[operation.name.split("_")[0]] ?? [];
          void queryClient.invalidateQueries({ predicate: (query) => scopes.includes(String(query.queryKey[0])) });
        },
      };
      const content = await runLiteAsk(request);
      assertCurrent();
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content, timestamp: Date.now() },
      ]);
    } catch (failure) {
      if (active.current === controller && !controller.signal.aborted) {
        setError(extractProxyErrorMessage(failure));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
        writeActive.current = false;
        setWriting(false);
      }
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button className="fixed bottom-5 right-5 z-floating rounded-full shadow-lg" />}>
        <Sparkles className="size-4" /> LiteAsk
      </SheetTrigger>
      <SheetContent
        initialFocus={pending ? reviewRef : true}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>LiteAsk</SheetTitle>
          <SheetDescription>Ask about your gateway. Review changes before they run.</SheetDescription>
        </SheetHeader>
        <GatewaySetup
          target={target}
          settingsPending={settingsPending}
          retrySettings={retrySettings}
          approved={approved}
          approve={() => setApproved(true)}
        />
        {ready && (
          <>
            <div className="flex items-center gap-3 border-b p-4">
              <div className="min-w-0 flex-1">
                <SearchSelect
                  options={(models.data ?? []).map((item) => ({ label: item.model_group, value: item.model_group }))}
                  value={selectedModel}
                  onValueChange={setModel}
                  aria-label="LiteAsk model"
                  placeholder={models.isPending ? "Loading models…" : "Select a model"}
                  disabled={busy || models.isPending}
                  allowClear={false}
                />
              </div>
              <Button variant="ghost" size="sm" onClick={reset} disabled={writing}>
                New chat
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-label="LiteAsk conversation">
              <LiteAskTranscript
                messages={messages}
                busy={busy}
                writing={writing}
                pending={pending}
                completed={completed}
                generatedKeys={generatedKeys}
                error={error}
                mutationOutcome={mutationOutcome}
              />
              <ChangeReview pending={pending} answer={answerReview} open={open} reviewRef={reviewRef} />
              {models.isError && (
                <p role="alert">
                  Could not load models.{" "}
                  <Button variant="link" onClick={() => void models.refetch()}>
                    Retry
                  </Button>
                </p>
              )}
              {noChatModels && <p role="status">Add a chat model to your gateway to use LiteAsk.</p>}
            </div>
            <LiteAskComposer
              value={input}
              onChange={setInput}
              onSubmit={() => void send()}
              placeholder="Ask LiteAsk…"
              disabled={busy}
              isLoading={busy}
              submitDisabled={!selectedModel}
              inputTooLong={inputTooLong}
              writing={writing}
              onCancel={() => {
                if (!writeActive.current) active.current?.abort();
              }}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function LiteAskComposer({
  inputTooLong,
  writing,
  ...props
}: ComponentProps<typeof ChatComposer> & { inputTooLong: boolean; writing: boolean }) {
  return (
    <div className="border-t p-4">
      {inputTooLong && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          Keep your message within {LITEASK_MAX_MESSAGE_LENGTH.toLocaleString()} characters.
        </p>
      )}
      <ChatComposer
        {...props}
        submitDisabled={props.submitDisabled || !props.value.trim() || inputTooLong}
        onCancel={writing ? undefined : props.onCancel}
      />
    </div>
  );
}

function GatewaySetup({
  target,
  settingsPending,
  retrySettings,
  approved,
  approve,
}: Pick<SessionProps, "target" | "settingsPending" | "retrySettings"> & {
  approved: boolean;
  approve: () => void;
}) {
  if (settingsPending) return <Skeleton className="m-4 h-24" aria-label="Loading gateway settings" />;
  if (!target)
    return (
      <div role="alert" className="space-y-3 p-4">
        <p>Could not load gateway settings.</p>
        <Button variant="outline" onClick={retrySettings}>
          Retry
        </Button>
      </div>
    );
  if (target.error)
    return (
      <p role="alert" className="p-4">
        {target.error}
      </p>
    );
  if (!target.requiresConsent || approved) return null;
  return (
    <div className="space-y-3 p-4">
      <p className="break-all font-mono text-sm">{target.baseUrl}</p>
      <p className="text-sm text-muted-foreground">
        This gateway uses a different address. LiteAsk will send your existing session credential to the address shown
        above.
      </p>
      <Button onClick={approve}>Use configured gateway</Button>
    </div>
  );
}

interface TranscriptProps {
  messages: ChatMessage[];
  busy: boolean;
  writing: boolean;
  pending: LiteAskConfirmation | null;
  completed: string[];
  generatedKeys: LiteAskGeneratedKey[];
  error: string | null;
  mutationOutcome: MutationOutcome;
}

function LiteAskTranscript({
  messages,
  busy,
  writing,
  pending,
  completed,
  generatedKeys,
  error,
  mutationOutcome,
}: TranscriptProps) {
  return (
    <>
      {messages.length === 0 && (
        <p className="text-sm text-muted-foreground">Check budgets, inspect usage, or manage keys and teams.</p>
      )}
      <ChatMessages messages={messages} isStreaming={busy} />
      {completed.map((title, index) => (
        <p key={index} role="status" className="text-sm text-success">
          Completed: {title}
        </p>
      ))}
      {busy && !pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {writing ? "Applying change…" : "Working…"}
        </p>
      )}
      {generatedKeys.map((key, index) => (
        <div key={index} className="space-y-2 rounded-lg border p-3">
          <p className="font-medium">{key.label}</p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all text-xs">{key.key}</code>
            <CopyButton value={key.key} label={`Copy ${key.label}`} />
          </div>
          <p className="text-xs text-muted-foreground">Copy this key now. It stays only in this chat session.</p>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {FAILURE_CONTEXT[mutationOutcome]}
          {error}
        </p>
      )}
    </>
  );
}

function ChangeReview({
  pending,
  answer,
  open,
  reviewRef,
}: {
  pending: LiteAskConfirmation | null;
  answer: (accepted: boolean) => void;
  open: boolean;
  reviewRef: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (open) reviewRef.current?.focus();
  }, [pending?.id, open, reviewRef]);
  if (!pending) return null;
  return (
    <section
      ref={reviewRef}
      tabIndex={-1}
      aria-label={pending.title}
      className="space-y-3 rounded-lg border bg-card p-4"
    >
      <h3 className="font-medium">{pending.title}</h3>
      <p className="text-sm text-muted-foreground">Review the exact change before it runs.</p>
      <p className="font-mono text-xs">{pending.name}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(pending.arguments, null, 2)}
      </pre>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => answer(false)}>
          Cancel
        </Button>
        <Button variant={pending.destructive ? "destructive" : "default"} onClick={() => answer(true)}>
          Confirm change
        </Button>
      </div>
    </section>
  );
}
