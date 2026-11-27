export class DuplicateReviewKeyError extends Error {
  constructor(readonly keys: string[]) {
    super(
      `Repeated review field ${keys.join(".")}. Return exactly one value-and-proof entry per field; re-read conflicting values from the original page.`,
    );
    this.name = "DuplicateReviewKeyError";
  }
}

/** JSON.parse silently overwrites repeated keys, including escaped spellings. */
export function parseReviewJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  let cursor = 0;
  const whitespace = () => {
    while (/\s/.test(raw[cursor] ?? "") && cursor < raw.length) cursor++;
  };
  const string = () => {
    const start = cursor++;
    while (cursor < raw.length) {
      const char = raw[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"') break;
    }
    return JSON.parse(raw.slice(start, cursor)) as string;
  };
  const visit = (keys: string[]) => {
    whitespace();
    if (raw[cursor] === "{") {
      cursor++;
      whitespace();
      const seen = new Set<string>();
      while (raw[cursor] !== "}") {
        const key = string();
        if (seen.has(key)) throw new DuplicateReviewKeyError([...keys, key]);
        seen.add(key);
        whitespace();
        cursor++; // colon; JSON.parse already checked the grammar
        visit([...keys, key]);
        whitespace();
        if (raw[cursor] !== ",") break;
        cursor++;
        whitespace();
      }
      cursor++;
    } else if (raw[cursor] === "[") {
      cursor++;
      whitespace();
      let index = 0;
      while (raw[cursor] !== "]") {
        visit([...keys, String(index++)]);
        whitespace();
        if (raw[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (raw[cursor] === '"') string();
    else {
      while (cursor < raw.length && !/[\s,\]}]/.test(raw[cursor])) cursor++;
    }
  };
  visit([]);
  return parsed;
}
