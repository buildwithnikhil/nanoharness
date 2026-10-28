import type { ContentBlock, Message } from "./types.js";

/** Adds a user message. If the history already ends with one, the text is merged into it, because two user turns in a row are invalid for most providers. */
export function appendUser(history: Message[], text: string): Message[] {
  const last = history.at(-1);
  if (last?.role === "user") {
    const blocks: ContentBlock[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    return [...history.slice(0, -1), { role: "user", content: [...blocks, { type: "text", text }] }];
  }
  return [...history, { role: "user", content: text }];
}

export function appendUserInPlace(messages: Message[], text: string): void {
  const next = appendUser(messages, text);
  messages.splice(0, messages.length, ...next);
}
