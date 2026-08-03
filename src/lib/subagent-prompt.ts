const NON_SUMMARY_LINE = /^(?:<\/?file\b|task\s*:?\s*$|execution mode\s*:|child checklist\s*:|acceptance contract\s*:|-{3,}|output\s*:)/i;
const RUNNER_PREAMBLE = /^(?:(?:task:\s*)?you are a delegated subagent running from a fork of the parent session\b|treat the inherited conversation as reference-only context\b|do not continue the parent task\b)/i;

function readableLine(value: string): string {
  return value
    .replace(/^\s*(?:#{1,6}|[-*+]\s+)\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
}

export function subagentPromptSummary(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  const chunkIndex = lines.findIndex((line) => /^chunk outcome\s*:/i.test(line));

  if (chunkIndex >= 0) {
    const inlineOutcome = readableLine(lines[chunkIndex].replace(/^chunk outcome\s*:\s*/i, ""));
    if (inlineOutcome) return inlineOutcome;

    const followingOutcome = lines
      .slice(chunkIndex + 1)
      .map(readableLine)
      .find((line) => line && !NON_SUMMARY_LINE.test(line));
    if (followingOutcome) return followingOutcome;
  }

  for (const rawLine of lines) {
    const line = readableLine(rawLine);
    if (!line || NON_SUMMARY_LINE.test(line) || RUNNER_PREAMBLE.test(line)) continue;
    return line.replace(/^task\s*:\s*/i, "");
  }

  return "View delegated task";
}
