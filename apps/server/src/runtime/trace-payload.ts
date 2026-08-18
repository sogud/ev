/**
 * Shared helpers for enriching trace events with trajectory fields
 * (tokensIn/tokensOut/input/output/ttftMs). Runtimes only fill what their
 * protocol actually provides; nothing here invents data.
 */

const MAX_TRACE_TEXT_CHARS = 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** Stringify + cap so a hostile/huge payload can never blow up the persisted trace. */
export function traceText(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();
  return text.slice(0, MAX_TRACE_TEXT_CHARS);
}

function asTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * Defensive usage extraction across runtime usage shapes:
 * pi `{input, output}`, Anthropic `{input_tokens, output_tokens}`,
 * OpenAI-style `{prompt_tokens, completion_tokens}`. Absent/invalid -> undefined.
 */
export function tokenCounts(usage: unknown): { tokensIn?: number; tokensOut?: number } {
  if (!isRecord(usage)) return {};
  const tokensIn = asTokenCount(usage.input ?? usage.input_tokens ?? usage.prompt_tokens);
  const tokensOut = asTokenCount(usage.output ?? usage.output_tokens ?? usage.completion_tokens);
  return {
    ...(tokensIn === undefined ? {} : { tokensIn }),
    ...(tokensOut === undefined ? {} : { tokensOut }),
  };
}
