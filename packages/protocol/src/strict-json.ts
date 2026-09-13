// Tokenize strings as whole units so escaped quotes/braces cannot become syntax.
// JSON.parse remains the syntax parser; this pass rejects duplicate keys and depth.
export const parseUniqueJson = (text: string): unknown => {
  try {
    const containers: (Set<string> | null)[] = [];
    for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/gu)) {
      const value = token[0];
      if (value === '{' || value === '[') {
        containers.push(value === '{' ? new Set() : null);
        if (containers.length > 32) throw new Error();
      } else if (value === '}' || value === ']') containers.pop();
      else {
        let end = token.index + value.length;
        while (/[\x20\t\n\r]/u.test(text[end] ?? '')) end += 1;
        if (text[end] !== ':') continue;
        const keys = containers.at(-1);
        if (!keys) throw new Error();
        const key = JSON.parse(value) as string;
        if (keys.has(key)) throw new Error();
        keys.add(key);
      }
    }
    return JSON.parse(text);
  } catch {
    throw new Error('REMOTE_STATE_INVALID');
  }
};
