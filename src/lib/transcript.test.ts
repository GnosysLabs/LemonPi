import { describe, expect, it, vi } from "vitest";
import { initialTranscriptState, reduceTranscript } from "./transcript";

vi.stubGlobal("crypto", { randomUUID: () => "test-id" });

describe("reduceTranscript", () => {
  it("streams thinking and text into one assistant item", () => {
    let state = reduceTranscript(initialTranscriptState, { type: "agent_start" });
    state = reduceTranscript(state, {
      type: "message_start",
      __lemonId: "1",
      message: { role: "assistant", content: [], timestamp: 1 },
    });
    state = reduceTranscript(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Checking" },
    });
    state = reduceTranscript(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", thinking: "Checking", text: "Hello" });
  });

  it("creates a pending card as soon as a streamed tool call is complete", () => {
    let state = reduceTranscript(initialTranscriptState, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pnpm test" } },
      },
    });
    expect(state.items[0]).toMatchObject({ kind: "tool", id: "call-1", name: "bash", status: "queued" });

    state = reduceTranscript(state, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "tool", id: "call-1", status: "running" });
  });

  it("tracks tool progress by tool call id", () => {
    let state = reduceTranscript(initialTranscriptState, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "pwd" },
    });
    state = reduceTranscript(state, {
      type: "tool_execution_update",
      toolCallId: "call-1",
      partialResult: { content: [{ type: "text", text: "/project" }] },
    });
    state = reduceTranscript(state, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "/project\n" }] },
      isError: false,
    });

    expect(state.items[0]).toMatchObject({ kind: "tool", id: "call-1", output: "/project\n", status: "complete" });
  });

  it("does not duplicate repeated tool starts", () => {
    const event = { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } };
    const once = reduceTranscript(initialTranscriptState, event);
    const twice = reduceTranscript(once, event);
    expect(twice.items).toHaveLength(1);
  });

  it("hydrates a switched session from Pi messages", () => {
    const state = reduceTranscript(initialTranscriptState, {
      type: "lemonpi_hydrate",
      messages: [
        { role: "user", content: "Previous question", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Previous answer" }], timestamp: 2 },
      ],
    });

    expect(state.items).toMatchObject([
      { kind: "user", text: "Previous question" },
      { kind: "assistant", text: "Previous answer", status: "complete" },
    ]);
  });

  it("shows a submitted message immediately and reconciles it when Pi accepts it", () => {
    let state = reduceTranscript(initialTranscriptState, {
      type: "lemonpi_queue_user",
      id: "pending-1",
      text: "Keep going",
      behavior: "prompt",
      attachments: [],
      createdAt: 1,
    });
    expect(state.items).toMatchObject([{ kind: "user", id: "pending-1", text: "Keep going", delivery: "pending" }]);

    state = reduceTranscript(state, {
      type: "message_start",
      __lemonId: "accepted",
      message: { role: "user", content: "Keep going", timestamp: 2 },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toEqual({ kind: "user", id: "pending-1", text: "Keep going", attachments: [], createdAt: 1 });
  });

  it("keeps attachments visible without dumping embedded file contents into the transcript", () => {
    const state = reduceTranscript(initialTranscriptState, {
      type: "message_start",
      __lemonId: "attachment",
      message: {
        role: "user",
        timestamp: 1,
        content: [
          {
            type: "text",
            text: "Review these\n\n<lemonpi-attachment name=\"screen.png\" mime=\"image/png\" size=\"3\" />\n\n<lemonpi-attachment name=\"notes.txt\" mime=\"text/plain\" size=\"5\">\nhello\n</lemonpi-attachment>",
          },
          { type: "image", data: "YWJj", mimeType: "image/png" },
        ],
      },
    });

    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "Review these",
      attachments: [
        { kind: "image", name: "screen.png", mimeType: "image/png", size: 3, data: "YWJj" },
        { kind: "text", name: "notes.txt", mimeType: "text/plain", size: 5 },
      ],
    });
  });
});
