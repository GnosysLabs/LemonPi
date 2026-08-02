export type ComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text";
  data?: string;
  text?: string;
};

export type PiPromptImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 5_500_000;

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const TEXT_EXTENSIONS = new Set([
  "c", "cc", "conf", "cpp", "cs", "css", "csv", "env", "go", "graphql", "h", "hpp", "html", "ini", "java", "js", "json", "jsx",
  "kt", "kts", "less", "log", "lua", "md", "mjs", "mts", "php", "plist", "properties", "py", "rb", "rs", "sass", "scss", "sh", "sql",
  "svg", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);

function extension(name: string): string {
  return name.split(".").at(-1)?.toLowerCase() ?? "";
}

function normalizedMimeType(file: File): string {
  const supplied = file.type.split(";")[0]?.trim().toLowerCase();
  return supplied || IMAGE_EXTENSIONS[extension(file.name)] || "text/plain";
}

function isTextFile(file: File, mimeType: string): boolean {
  return mimeType.startsWith("text/")
    || ["application/json", "application/ld+json", "application/javascript", "application/sql", "application/toml", "application/xml", "application/x-httpd-php", "application/x-sh", "application/x-yaml"].includes(mimeType)
    || TEXT_EXTENSIONS.has(extension(file.name));
}

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

export async function readComposerAttachment(file: File): Promise<ComposerAttachment> {
  const mimeType = normalizedMimeType(file);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than the 5 MB attachment limit.`);
  }
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    const encoded = await dataUrl(file);
    const separator = encoded.indexOf(",");
    if (separator < 0) throw new Error(`Could not encode ${file.name}.`);
    return { id: crypto.randomUUID(), name: file.name, mimeType, size: file.size, kind: "image", data: encoded.slice(separator + 1) };
  }
  if (!isTextFile(file, mimeType)) {
    throw new Error(`${file.name} is not a supported image or text/code file.`);
  }
  if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than the 512 KB text-file limit.`);
  }
  return { id: crypto.randomUUID(), name: file.name, mimeType, size: file.size, kind: "text", text: await file.text() };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPromptWithAttachments(text: string, attachments: ComposerAttachment[]): string {
  const blocks = attachments.map((attachment) => {
    const attributes = `name="${escapeAttribute(attachment.name)}" mime="${escapeAttribute(attachment.mimeType)}" size="${attachment.size}"`;
    return attachment.kind === "image"
      ? `<lemonpi-attachment ${attributes} />`
      : `<lemonpi-attachment ${attributes}>\n${attachment.text ?? ""}\n</lemonpi-attachment>`;
  });
  return [text.trim(), ...blocks].filter(Boolean).join("\n\n");
}

export function promptImages(attachments: ComposerAttachment[]): PiPromptImage[] {
  return attachments.flatMap((attachment) => attachment.kind === "image" && attachment.data
    ? [{ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }]
    : []);
}
