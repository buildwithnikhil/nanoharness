import type { Message } from "./types.js";

// A history can only start with a user message that is not a tool result: a tool result needs the assistant
// message with its tool call right before it.
const cleanStart = (m: Message | undefined): boolean =>
  m?.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));

/**
 * Keeps the most recent part of a conversation: at most `maxMessages` messages, cut at a point where the
 * history is still valid (it starts with a plain user message, so no tool result is separated from its tool call).
 * If no such point exists within the limit, it keeps the shortest valid tail, which can be a little longer.
 * Returns a suffix of `messages`, so `messages.slice(0, messages.length - kept.length)` is what was dropped.
 */
export function trimHistory(messages: Message[], opts: { maxMessages: number }): Message[] {
  const max = Math.max(1, Math.floor(opts.maxMessages));
  if (messages.length <= max) return [...messages];
  let start = messages.length - max;
  while (start < messages.length && !cleanStart(messages[start])) start++;
  if (start === messages.length) {
    start = messages.length - max;
    while (start > 0 && !cleanStart(messages[start])) start--;
  }
  return messages.slice(start);
}

/** Puts a summary of dropped messages at the front of the first kept message, so the history stays valid. */
export function withSummary(kept: Message[], summary: string): Message[] {
  const note = `Summary of the earlier conversation:\n${summary}`;
  const [first, ...rest] = kept;
  if (!first) return [{ role: "user", content: note }];
  const blocks = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
  return [{ role: first.role, content: [{ type: "text", text: note }, ...blocks] }, ...rest];
}
