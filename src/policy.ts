import type { Decision } from "./agent.js";
import type { ToolUseBlock } from "./types.js";

/** `onToolCall` policy that only lets the named tools run. */
export function allowTools(names: string[]): (call: ToolUseBlock) => Decision {
  const allowed = new Set(names);
  return (call) => (allowed.has(call.name) ? "allow" : { deny: `tool "${call.name}" is not allowed` });
}

/**
 * `onToolResult` helper that fences tool output as untrusted data, so the model
 * can be told (in the system prompt) never to follow instructions found inside it.
 * This reduces prompt-injection risk but does not eliminate it.
 */
export function markUntrusted(tag = "untrusted_tool_output"): (r: { content: string }) => string {
  const close = new RegExp(`</${tag}>`, "gi");
  return ({ content }) => `<${tag}>\n${content.replace(close, `<\\/${tag}>`)}\n</${tag}>`;
}
