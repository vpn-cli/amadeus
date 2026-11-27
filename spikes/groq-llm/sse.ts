export interface SseEvent {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

/**
 * Pure incremental Server-Sent Events (SSE) parser.
 * Handles arbitrary chunk boundaries, multi-byte UTF-8 sequences, CRLF/LF,
 * comments, and multi-line `data:` fields without I/O or timers.
 */
export class SseParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private lineBuffer = "";
  private eventName: string | undefined;
  private eventId: string | undefined;
  private dataLines: string[] = [];

  push(chunk: Uint8Array | string): SseEvent[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text.length === 0) return [];
    this.lineBuffer += text;
    return this.drainLines(false);
  }

  flush(): SseEvent[] {
    const tail = this.decoder.decode();
    if (tail.length > 0) {
      this.lineBuffer += tail;
    }
    const events = this.drainLines(true);
    const trailingEvent = this.dispatchEvent();
    if (trailingEvent !== undefined) {
      events.push(trailingEvent);
    }
    return events;
  }

  private drainLines(isFlush: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;

    while (start < this.lineBuffer.length) {
      const lfIndex = this.lineBuffer.indexOf("\n", start);
      if (lfIndex === -1) {
        break;
      }
      let line = this.lineBuffer.slice(start, lfIndex);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      start = lfIndex + 1;
      const evt = this.processLine(line);
      if (evt !== undefined) {
        events.push(evt);
      }
    }

    this.lineBuffer = this.lineBuffer.slice(start);

    if (isFlush && this.lineBuffer.length > 0) {
      let line = this.lineBuffer;
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.lineBuffer = "";
      const evt = this.processLine(line);
      if (evt !== undefined) {
        events.push(evt);
      }
    }

    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line.length === 0) {
      return this.dispatchEvent();
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventName = value;
    } else if (field === "id" && !value.includes("\0")) {
      this.eventId = value;
    }
    return undefined;
  }

  private dispatchEvent(): SseEvent | undefined {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      this.eventId = undefined;
      return undefined;
    }
    const event: SseEvent = {
      ...(this.eventName !== undefined ? { event: this.eventName } : {}),
      ...(this.eventId !== undefined ? { id: this.eventId } : {}),
      data: this.dataLines.join("\n"),
    };
    this.dataLines = [];
    this.eventName = undefined;
    this.eventId = undefined;
    return event;
  }
}
