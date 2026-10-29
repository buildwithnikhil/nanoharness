export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set by an adapter when the provider's tool call was malformed. The tool is not run and the model is told. */
  error?: string;
  /** Opaque data a provider needs sent back with this call, such as Gemini's thought signature. Kept in the history. */
  signature?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AdapterRequest {
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export type AdapterStopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface AdapterResponse {
  content: Array<TextBlock | ToolUseBlock>;
  stopReason: AdapterStopReason;
  usage?: Usage;
}

/** What an adapter's optional `stream` yields: text as it arrives, then exactly one final response. */
export type AdapterStreamEvent = { type: "text_delta"; text: string } | { type: "response"; response: AdapterResponse };

/** The only surface a model provider has to implement. `stream` is optional and used when a run asks for streaming. */
export interface Adapter {
  complete(req: AdapterRequest): Promise<AdapterResponse>;
  stream?(req: AdapterRequest): AsyncIterable<AdapterStreamEvent>;
}

/** Minimal key-value persistence used by sessions, plans and graph checkpoints. */
export interface Store {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  /**
   * Optional. Runs `fn` while holding an exclusive lock on `key`. A store shared by several processes
   * should provide it. Without it, sessions and graphs queue runs within one process only.
   */
  lock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
