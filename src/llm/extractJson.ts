export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('LLM response did not contain a JSON object.');
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error('LLM response contained invalid JSON.');
  }
}
