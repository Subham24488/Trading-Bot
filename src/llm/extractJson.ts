function stripThinking(text: string): string {
  let cleaned = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  const openThink = cleaned.search(/<think\b[^>]*>/i);
  if (openThink >= 0) {
    const jsonStart = cleaned.indexOf('{', openThink);
    cleaned = jsonStart >= 0 ? cleaned.slice(0, openThink) + cleaned.slice(jsonStart) : cleaned.slice(0, openThink);
  }
  return cleaned.replace(/<\/?think\b[^>]*>/gi, '').trim();
}

function sliceBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = stripThinking(text);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const objectText = sliceBalancedObject(candidate);
  if (!objectText) {
    throw new Error(
      'LLM response did not contain a JSON object. The model likely used the token budget on hidden reasoning; thinking is disabled on retry.',
    );
  }

  try {
    return JSON.parse(objectText) as unknown;
  } catch {
    throw new Error('LLM response contained invalid JSON.');
  }
}
