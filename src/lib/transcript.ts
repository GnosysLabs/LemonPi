import type { AgentMessage, ContentPart, PiEvent } from "./pi-types";

export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      text: string;
      attachments: TranscriptAttachment[];
      createdAt: number;
      delivery?: "pending" | "failed";
      deliveryBehavior?: "prompt" | "steer" | "follow_up";
      deliveryError?: string;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      thinking: string;
      createdAt: number;
      status: "streaming" | "complete" | "aborted" | "error";
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      output: string;
      createdAt: number;
      status: "queued" | "running" | "complete" | "error";
    };

export type TranscriptAttachment = {
  name: string;
  mimeType: string;
  size?: number;
  kind: "image" | "text";
  data?: string;
};

export interface TranscriptState {
  items: TranscriptItem[];
  activeAssistantId?: string;
  isStreaming: boolean;
}

export const initialTranscriptState: TranscriptState = {
  items: [],
  isStreaming: false,
};

function contentText(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

const ATTACHMENT_TAG = /<lemonpi-attachment\s+name="([^"]*)"\s+mime="([^"]*)"\s+size="(\d+)"(?:\s*\/>|>([\s\S]*?)<\/lemonpi-attachment>)/g;

function decodeAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function userMessageContent(content: AgentMessage["content"]): { text: string; attachments: TranscriptAttachment[] } {
  const rawText = contentText(content);
  const descriptors: Array<{ name: string; mimeType: string; size: number; kind: "image" | "text" }> = [];
  const text = rawText.replace(ATTACHMENT_TAG, (_match, name: string, mimeType: string, size: string, fileContents?: string) => {
    descriptors.push({
      name: decodeAttribute(name),
      mimeType: decodeAttribute(mimeType),
      size: Number(size),
      kind: fileContents === undefined ? "image" : "text",
    });
    return "";
  }).trim();
  const imageParts = Array.isArray(content)
    ? content.filter((part) => part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
    : [];
  let imageIndex = 0;
  const attachments = descriptors.map((descriptor): TranscriptAttachment => {
    if (descriptor.kind === "text") return descriptor;
    const part = imageParts[imageIndex++];
    return { ...descriptor, mimeType: part?.mimeType ?? descriptor.mimeType, data: part?.data };
  });
  for (; imageIndex < imageParts.length; imageIndex += 1) {
    const part = imageParts[imageIndex];
    attachments.push({ name: `Image ${imageIndex + 1}`, mimeType: part.mimeType!, kind: "image", data: part.data });
  }
  return { text, attachments };
}

function thinkingText(content: AgentMessage["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "thinking" && typeof part.thinking === "string")
    .map((part) => part.thinking)
    .join("\n");
}

function resultText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is ContentPart => Boolean(part) && typeof part === "object")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function eventMessage(event: PiEvent): AgentMessage | undefined {
  const message = event.message;
  return message && typeof message === "object" ? (message as AgentMessage) : undefined;
}

function timestamp(message?: AgentMessage): number {
  return typeof message?.timestamp === "number" ? message.timestamp : Date.now();
}

function eventId(event: PiEvent, prefix: string): string {
  const explicit = event.__lemonId;
  return typeof explicit === "string" ? `${prefix}-${explicit}` : `${prefix}-${crypto.randomUUID()}`;
}

function updateAssistant(
  state: TranscriptState,
  id: string,
  patch: Partial<Extract<TranscriptItem, { kind: "assistant" }>>,
): TranscriptState {
  return {
    ...state,
    items: state.items.map((item) => (item.kind === "assistant" && item.id === id ? { ...item, ...patch } : item)),
  };
}

function ensureAssistant(state: TranscriptState, event: PiEvent): [TranscriptState, string] {
  if (state.activeAssistantId) return [state, state.activeAssistantId];
  const id = eventId(event, "assistant");
  return [
    {
      ...state,
      activeAssistantId: id,
      items: [
        ...state.items,
        { kind: "assistant", id, text: "", thinking: "", createdAt: Date.now(), status: "streaming" },
      ],
    },
    id,
  ];
}

export function reduceTranscript(state: TranscriptState, event: PiEvent): TranscriptState {
  switch (event.type) {
    case "lemonpi_reset":
      return initialTranscriptState;
    case "lemonpi_hydrate":
      return hydrateTranscript(Array.isArray(event.messages) ? event.messages as AgentMessage[] : []);
    case "lemonpi_queue_user": {
      const text = typeof event.text === "string" ? event.text : "";
      const attachments = Array.isArray(event.attachments) ? event.attachments as TranscriptAttachment[] : [];
      if (!text && attachments.length === 0) return state;
      return {
        ...state,
        items: [...state.items, {
          kind: "user",
          id: typeof event.id === "string" ? event.id : eventId(event, "pending-user"),
          text,
          attachments,
          createdAt: typeof event.createdAt === "number" ? event.createdAt : Date.now(),
          delivery: "pending",
          deliveryBehavior: event.behavior === "steer" || event.behavior === "follow_up" ? event.behavior : "prompt",
        }],
      };
    }
    case "lemonpi_queue_user_failed":
      return {
        ...state,
        items: state.items.map((item) => item.kind === "user" && item.id === event.id
          ? { ...item, delivery: "failed", deliveryError: typeof event.error === "string" ? event.error : "Pi could not accept this message." }
          : item),
      };
    case "agent_start":
      return { ...state, isStreaming: true };
    case "agent_settled":
      return { ...state, isStreaming: false, activeAssistantId: undefined };
    case "message_start": {
      const message = eventMessage(event);
      if (!message) return state;
      if (message.role === "user") {
        const { text, attachments } = userMessageContent(message.content);
        if (!text && attachments.length === 0) return state;
        const pendingIndex = state.items.findIndex((item) => item.kind === "user"
          && item.delivery !== undefined
          && item.text.trim() === text.trim()
          && item.attachments.length === attachments.length);
        if (pendingIndex >= 0) {
          return {
            ...state,
            items: state.items.map((item, index) => index === pendingIndex
              ? { kind: "user", id: item.id, text, attachments, createdAt: item.createdAt }
              : item),
          };
        }
        return {
          ...state,
          items: [...state.items, { kind: "user", id: eventId(event, "user"), text, attachments, createdAt: timestamp(message) }],
        };
      }
      if (message.role === "assistant" && !state.activeAssistantId) {
        const id = eventId(event, "assistant");
        return {
          ...state,
          activeAssistantId: id,
          items: [
            ...state.items,
            { kind: "assistant", id, text: "", thinking: "", createdAt: timestamp(message), status: "streaming" },
          ],
        };
      }
      return state;
    }
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (!update || typeof update !== "object") return state;
      const delta = update as { type?: string; delta?: string; toolCall?: ContentPart };
      if (delta.type === "toolcall_end") {
        const toolCall = delta.toolCall;
        if (!toolCall?.id || !toolCall.name) return state;
        const existing = state.items.find((item) => item.kind === "tool" && item.id === toolCall.id);
        if (existing) return state;
        return {
          ...state,
          items: [
            ...state.items,
            {
              kind: "tool",
              id: toolCall.id,
              name: toolCall.name,
              args: toolCall.arguments ?? {},
              output: "",
              createdAt: Date.now(),
              status: "queued",
            },
          ],
        };
      }
      if ((delta.type !== "text_delta" && delta.type !== "thinking_delta") || typeof delta.delta !== "string") return state;
      const [next, id] = ensureAssistant(state, event);
      const current = next.items.find((item) => item.kind === "assistant" && item.id === id);
      if (!current || current.kind !== "assistant") return next;
      return updateAssistant(
        next,
        id,
        delta.type === "text_delta"
          ? { text: current.text + delta.delta }
          : { thinking: current.thinking + delta.delta },
      );
    }
    case "message_end": {
      const message = eventMessage(event);
      if (!message) return state;
      if (message.role === "assistant") {
        const [next, id] = ensureAssistant(state, event);
        const stopReason = (message as AgentMessage & { stopReason?: string }).stopReason;
        return {
          ...updateAssistant(next, id, {
            text: contentText(message.content),
            thinking: thinkingText(message.content),
            status: stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "complete",
          }),
          activeAssistantId: undefined,
        };
      }
      if (message.role === "toolResult" && message.toolCallId) {
        const index = state.items.findIndex((item) => item.kind === "tool" && item.id === message.toolCallId);
        if (index < 0) return state;
        return {
          ...state,
          items: state.items.map((item, itemIndex) =>
            itemIndex === index && item.kind === "tool"
              ? { ...item, output: contentText(message.content), status: message.isError ? "error" : "complete" }
              : item,
          ),
        };
      }
      return state;
    }
    case "tool_execution_start": {
      if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return state;
      const args = event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {};
      if (state.items.some((item) => item.kind === "tool" && item.id === event.toolCallId)) {
        return {
          ...state,
          items: state.items.map((item) => item.kind === "tool" && item.id === event.toolCallId
            ? { ...item, name: event.toolName as string, args, status: "running" }
            : item),
        };
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: event.toolCallId,
            name: event.toolName,
            args,
            output: "",
            createdAt: Date.now(),
            status: "running",
          },
        ],
      };
    }
    case "tool_execution_update": {
      if (typeof event.toolCallId !== "string") return state;
      const output = resultText(event.partialResult);
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "tool" && item.id === event.toolCallId ? { ...item, output } : item,
        ),
      };
    }
    case "tool_execution_end": {
      if (typeof event.toolCallId !== "string") return state;
      const output = resultText(event.result);
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "tool" && item.id === event.toolCallId
            ? { ...item, output, status: event.isError === true ? "error" : "complete" }
            : item,
        ),
      };
    }
    default:
      return state;
  }
}

export function hydrateTranscript(messages: AgentMessage[]): TranscriptState {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();

  for (const message of messages) {
    if (message.role === "user") {
      const { text, attachments } = userMessageContent(message.content);
      if (text || attachments.length > 0) items.push({ kind: "user", id: `user-${crypto.randomUUID()}`, text, attachments, createdAt: timestamp(message) });
      continue;
    }
    if (message.role === "assistant") {
      items.push({
        kind: "assistant",
        id: `assistant-${crypto.randomUUID()}`,
        text: contentText(message.content),
        thinking: thinkingText(message.content),
        createdAt: timestamp(message),
        status: "complete",
      });
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type !== "toolCall" || !part.id || !part.name) continue;
          const tool: Extract<TranscriptItem, { kind: "tool" }> = {
            kind: "tool",
            id: part.id,
            name: part.name,
            args: part.arguments ?? {},
            output: "",
            createdAt: timestamp(message),
            status: "running",
          };
          tools.set(part.id, tool);
          items.push(tool);
        }
      }
      continue;
    }
    if (message.role === "toolResult" && message.toolCallId) {
      const tool = tools.get(message.toolCallId);
      if (tool) {
        tool.output = contentText(message.content);
        tool.status = message.isError ? "error" : "complete";
      }
    }
  }

  return { items, isStreaming: false };
}
