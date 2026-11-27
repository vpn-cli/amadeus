const ABBREVIATIONS = new Set([
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "sr.",
  "jr.",
  "st.",
  "vs.",
  "etc.",
  "e.g.",
  "i.e.",
  "no.",
  "fig.",
  "inc.",
  "ltd.",
  "approx.",
  "est.",
]);

const SENTENCE_TERMINATORS = new Set([".", "?", "!"]);
const CLOSING_PUNCT = new Set(['"', "'", "”", "’", ")", "]", "}"]);
const WHITESPACE_RE = /\s/;
const DIGIT_RE = /\d/;
const MULTI_INITIAL_ABBR_RE = /(?:[a-zA-Z]\.){2,}$/;

/**
 * Pure streaming sentence splitter.
 * A sentence completes only once the character AFTER the terminator
 * (plus any immediate closing quotes/brackets) is seen: whitespace or EOS.
 */
export class SentenceSplitter {
  private buffer = "";
  private scanIndex = 0;

  push(delta: string): string[] {
    if (delta.length === 0) return [];
    this.buffer += delta;
    return this.extractCompletedSentences();
  }

  flush(): string[] {
    const sentences = this.extractCompletedSentences();
    const rest = this.buffer.trim();
    this.buffer = "";
    this.scanIndex = 0;
    if (rest.length > 0) {
      sentences.push(rest);
    }
    return sentences;
  }

  private extractCompletedSentences(): string[] {
    const out: string[] = [];

    while (this.scanIndex < this.buffer.length) {
      const ch = this.buffer[this.scanIndex];
      if (ch === undefined || !SENTENCE_TERMINATORS.has(ch)) {
        this.scanIndex += 1;
        continue;
      }

      // Skip consecutive dots (ellipsis ".." / "...") as non-terminating.
      if (ch === ".") {
        const prevChar = this.scanIndex > 0 ? this.buffer[this.scanIndex - 1] : undefined;
        const nextChar = this.buffer[this.scanIndex + 1];
        if (nextChar === undefined) {
          // Wait for the next character after '.' before deciding.
          break;
        }
        if (prevChar === "." || nextChar === ".") {
          // Consume the entire dot run as an ellipsis.
          while (this.scanIndex < this.buffer.length && this.buffer[this.scanIndex] === ".") {
            this.scanIndex += 1;
          }
          continue;
        }
        // Check decimal (e.g., "1.5"): digit before and digit after '.'.
        if (prevChar !== undefined && DIGIT_RE.test(prevChar) && DIGIT_RE.test(nextChar)) {
          this.scanIndex += 1;
          continue;
        }
      }

      // Advance past any immediate closing quote/bracket characters.
      let endAfterClosers = this.scanIndex + 1;
      while (
        endAfterClosers < this.buffer.length &&
        CLOSING_PUNCT.has(this.buffer[endAfterClosers] ?? "")
      ) {
        endAfterClosers += 1;
      }

      // Must see the character AFTER the terminator (+ closers) before splitting.
      if (endAfterClosers >= this.buffer.length) {
        break;
      }

      const followingChar = this.buffer[endAfterClosers] ?? "";
      if (!WHITESPACE_RE.test(followingChar)) {
        // Not followed by whitespace (e.g., "e.g." mid-token or "foo.bar").
        this.scanIndex = endAfterClosers;
        continue;
      }

      if (ch === "." && this.isAbbreviationAt(this.scanIndex)) {
        this.scanIndex = endAfterClosers;
        continue;
      }

      const sentence = this.buffer.slice(0, endAfterClosers).trim();
      if (sentence.length > 0) {
        out.push(sentence);
      }

      // Consume trailing whitespace before next sentence.
      let nextStart = endAfterClosers;
      while (nextStart < this.buffer.length && WHITESPACE_RE.test(this.buffer[nextStart] ?? "")) {
        nextStart += 1;
      }
      this.buffer = this.buffer.slice(nextStart);
      this.scanIndex = 0;
    }

    return out;
  }

  private isAbbreviationAt(dotIndex: number): boolean {
    let tokenStart = dotIndex;
    while (tokenStart > 0 && !WHITESPACE_RE.test(this.buffer[tokenStart - 1] ?? "")) {
      tokenStart -= 1;
    }
    const rawToken = this.buffer
      .slice(tokenStart, dotIndex + 1)
      .replace(/^[\s("'“‘\[]+/, "");
    const lowerToken = rawToken.toLowerCase();
    if (ABBREVIATIONS.has(lowerToken)) {
      return true;
    }
    return MULTI_INITIAL_ABBR_RE.test(rawToken);
  }
}
