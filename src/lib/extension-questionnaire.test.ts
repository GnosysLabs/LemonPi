import { describe, expect, it } from "vitest";
import { parseQuestionnairePrompt } from "./extension-questionnaire";

describe("parseQuestionnairePrompt", () => {
  it("turns the ask-user-question select fallback into rich option data", () => {
    const prompt = parseQuestionnairePrompt({
      type: "extension_ui_request",
      id: "question-1",
      method: "select",
      title: "[Storage] Which cache should we use?\n\n--- 1. SQLite preview ---\n```sql\nCREATE TABLE cache\n```",
      options: [
        "1. SQLite — Durable and local",
        "2. Memory — Fast but temporary",
        "3. Type something.",
      ],
    });

    expect(prompt).toMatchObject({
      kind: "single",
      header: "Storage",
      question: "Which cache should we use?",
    });
    expect(prompt?.options[0]).toMatchObject({
      number: 1,
      label: "SQLite",
      description: "Durable and local",
      preview: "```sql\nCREATE TABLE cache\n```",
    });
    expect(prompt?.options[2].custom).toBe(true);
  });

  it("recognizes the RPC multi-select fallback", () => {
    const prompt = parseQuestionnairePrompt({
      type: "extension_ui_request",
      id: "question-2",
      method: "input",
      title: "[Features] Which features should ship?\n\n1. Search — Find content\n2. Export — Download data\n\nEnter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text.",
    });

    expect(prompt).toMatchObject({ kind: "multi", header: "Features", question: "Which features should ship?" });
    expect(prompt?.options.map((option) => option.label)).toEqual(["Search", "Export"]);
  });
});
