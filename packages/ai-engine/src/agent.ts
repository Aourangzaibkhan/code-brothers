/**
 * ReAct agent runner (spec §4B — autonomous tool-calling assistants).
 *
 * The model speaks a deliberately simple JSON tool-call protocol (defined
 * in the system prompt we assemble):
 *
 *   {"tool_call": {"name": "<tool>", "arguments": { ... }}}
 *
 * Safety properties:
 *  - Only whitelisted tools (the ones handed to runAgent) can ever run;
 *    any other name is refused and the refusal is fed back to the model.
 *  - Hard circuit breaker: at most `maxSteps` model calls (default 5);
 *    a looping model is stopped, never left running.
 *  - Every step is logged through @code-brothers/security's redact(), so
 *    secrets in messages/tool output never reach a log sink.
 */

import { redact } from '@code-brothers/security';
import type { ChatMessage, ChatProvider } from './types.js';

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface AgentStep {
  step: number;
  type: 'model' | 'tool' | 'refused' | 'final' | 'breaker';
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface RunAgentOptions {
  provider: ChatProvider;
  tools: AgentTool[];
  systemPrompt: string;
  userMessage: string;
  /** Hard cap on model calls. Default 5 (spec §8: 5-step loop breaker). */
  maxSteps?: number;
  /** Log sink; receives already-redacted step entries. Default: collect only. */
  log?: (entry: AgentStep) => void;
}

export interface AgentResult {
  finalText: string;
  steps: AgentStep[];
  toolCalls: number;
  stoppedByBreaker: boolean;
}

export const TOOL_PROTOCOL_INSTRUCTIONS = [
  'You are an autonomous assistant that can call tools.',
  'To call a tool, reply with ONLY a JSON object in exactly this shape:',
  '{"tool_call": {"name": "<tool name>", "arguments": {<arguments object>}}}',
  'Call at most one tool per reply. After a tool runs, its result is given back to you.',
  'When you have the final answer, reply with plain text only — no JSON.',
].join('\n');

export function buildAgentSystemPrompt(systemPrompt: string, tools: AgentTool[]): string {
  const toolList = tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description} | parameters: ${JSON.stringify(t.parameters)}`,
    )
    .join('\n');
  return `${systemPrompt}\n\n${TOOL_PROTOCOL_INSTRUCTIONS}\n\nAvailable tools:\n${toolList || '(none)'}`;
}

interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Extract a {"tool_call": {...}} object from model text using a
 * string-aware balanced-brace scan (arguments may nest objects).
 */
export function extractToolCall(text: string): ParsedToolCall | null {
  const marker = text.indexOf('"tool_call"');
  if (marker === -1) return null;
  const start = text.lastIndexOf('{', marker);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as {
            tool_call?: { name?: unknown; arguments?: unknown };
          };
          const call = parsed.tool_call;
          if (!call || typeof call.name !== 'string') return null;
          const args =
            call.arguments && typeof call.arguments === 'object'
              ? (call.arguments as Record<string, unknown>)
              : {};
          return { name: call.name, arguments: args };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const maxSteps = opts.maxSteps ?? 5;
  if (maxSteps < 1) throw new Error('maxSteps must be at least 1');
  const whitelist = new Map(opts.tools.map((t) => [t.name, t]));
  const steps: AgentStep[] = [];
  const emit = (entry: AgentStep) => {
    const safe = redact(entry) as AgentStep;
    steps.push(safe);
    opts.log?.(safe);
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: buildAgentSystemPrompt(opts.systemPrompt, opts.tools) },
    { role: 'user', content: opts.userMessage },
  ];

  let toolCalls = 0;
  let lastText = '';

  for (let step = 1; step <= maxSteps; step++) {
    const res = await opts.provider.chat(messages);
    lastText = res.text;
    emit({ step, type: 'model', text: res.text });
    const call = extractToolCall(res.text);

    if (!call) {
      emit({ step, type: 'final', text: res.text });
      return { finalText: res.text, steps, toolCalls, stoppedByBreaker: false };
    }

    const tool = whitelist.get(call.name);
    if (!tool) {
      emit({ step, type: 'refused', tool: call.name, args: call.arguments });
      messages.push({ role: 'assistant', content: res.text });
      messages.push({
        role: 'user',
        content:
          `Tool "${call.name}" is not available. You may only use: ` +
          `${[...whitelist.keys()].join(', ') || '(no tools)'}. ` +
          'Try again with an allowed tool, or give a final plain-text answer.',
      });
      continue;
    }

    toolCalls++;
    let result: unknown;
    try {
      result = await tool.run(call.arguments);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    emit({ step, type: 'tool', tool: call.name, args: call.arguments, result });
    messages.push({ role: 'assistant', content: res.text });
    messages.push({
      role: 'user',
      content: `Tool result for ${call.name}: ${JSON.stringify(result) ?? 'null'}`,
    });
  }

  emit({ step: maxSteps, type: 'breaker', text: lastText });
  return { finalText: lastText, steps, toolCalls, stoppedByBreaker: true };
}
