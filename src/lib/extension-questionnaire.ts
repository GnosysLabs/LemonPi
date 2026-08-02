import type { RpcExtensionUiRequest } from "./pi-types";

export type QuestionnaireOption = {
  number: number;
  label: string;
  description?: string;
  preview?: string;
  responseValue: string;
  custom: boolean;
};

export type QuestionnairePrompt = {
  kind: "single" | "multi" | "custom";
  header?: string;
  question: string;
  options: QuestionnaireOption[];
};

const NUMBERED_OPTION = /^(\d+)\.\s+(.+?)(?:\s+—\s+(.+))?$/;
const PREVIEW_START = /^---\s+(\d+)\.\s+.+?\s+preview\s+---$/;
const MULTI_INSTRUCTIONS = "Enter the numbers of all that apply";
const CUSTOM_ANSWER_TITLE = "Type your answer:";

function extractHeader(title: string): { header?: string; rest: string } {
  const match = title.match(/^\[([^\]]+)]\s*/);
  return match
    ? { header: match[1].trim(), rest: title.slice(match[0].length) }
    : { rest: title };
}

function extractPreviews(title: string): Map<number, string> {
  const previews = new Map<number, string>();
  const lines = title.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].trim().match(PREVIEW_START);
    if (!start) continue;
    const body: string[] = [];
    for (index += 1; index < lines.length && !PREVIEW_START.test(lines[index].trim()); index += 1) {
      body.push(lines[index]);
    }
    index -= 1;
    previews.set(Number(start[1]), body.join("\n").trim());
  }
  return previews;
}

function parseOption(value: string, preview?: string): QuestionnaireOption | undefined {
  const match = value.trim().match(NUMBERED_OPTION);
  if (!match) return undefined;
  const label = match[2].trim();
  return {
    number: Number(match[1]),
    label,
    description: match[3]?.trim(),
    preview,
    responseValue: value,
    custom: /^(type something\.?|other)$/i.test(label),
  };
}

export function parseQuestionnairePrompt(request: RpcExtensionUiRequest): QuestionnairePrompt | undefined {
  if (request.method !== "select" && request.method !== "input") return undefined;
  const title = request.title?.trim();
  if (!title) return undefined;
  const { header, rest } = extractHeader(title);

  if (request.method === "select" && request.options?.length) {
    const previews = extractPreviews(rest);
    const question = rest.split(/\n\n---\s+\d+\./, 1)[0].trim();
    const options = request.options
      .map((option, index) => {
        const number = Number(option.match(NUMBERED_OPTION)?.[1]);
        const parsed = parseOption(option, previews.get(number));
        if (parsed && index === request.options!.length - 1 && !parsed.description) {
          parsed.custom = true;
        }
        return parsed;
      })
      .filter((option): option is QuestionnaireOption => Boolean(option));
    if (question && options.length === request.options.length) {
      return { kind: "single", header, question, options };
    }
  }

  if (request.method === "input" && rest.includes(MULTI_INSTRUCTIONS)) {
    const lines = rest.split("\n");
    const instructionIndex = lines.findIndex((line) => line.includes(MULTI_INSTRUCTIONS));
    const optionLines = lines.slice(1, instructionIndex).map((line) => line.trim()).filter(Boolean);
    const options = optionLines
      .map((option) => parseOption(option))
      .filter((option): option is QuestionnaireOption => Boolean(option));
    if (lines[0]?.trim() && options.length >= 2) {
      return { kind: "multi", header, question: lines[0].trim(), options };
    }
  }

  if (request.method === "input" && rest.includes(CUSTOM_ANSWER_TITLE)) {
    return {
      kind: "custom",
      header,
      question: rest.slice(0, rest.indexOf(CUSTOM_ANSWER_TITLE)).trim(),
      options: [],
    };
  }

  return undefined;
}
