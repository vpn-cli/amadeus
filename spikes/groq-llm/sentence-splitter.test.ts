import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./sentence-splitter.js";

function feedOneByOne(text: string): string[] {
  const splitter = new SentenceSplitter();
  const out: string[] = [];
  for (const ch of text) {
    out.push(...splitter.push(ch));
  }
  out.push(...splitter.flush());
  return out;
}

describe("SentenceSplitter", () => {
  it("completes a sentence only after seeing whitespace or end after terminator", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Hello world")).toEqual([]);
    expect(splitter.push(".")).toEqual([]);
    expect(splitter.push(" Next")).toEqual(["Hello world."]);
    expect(splitter.push(" sentence!")).toEqual([]);
    expect(splitter.flush()).toEqual(["Next sentence!"]);
  });

  it("handles terminators split across deltas", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("First part")).toEqual([]);
    expect(splitter.push("?")).toEqual([]);
    expect(splitter.push("\nSecond")).toEqual(["First part?"]);
    expect(splitter.flush()).toEqual(["Second"]);
  });

  it("does not split on decimals like 1.5", () => {
    expect(feedOneByOne("The package weighs 1.5 kg. Shipping takes 2.0 days.")).toEqual([
      "The package weighs 1.5 kg.",
      "Shipping takes 2.0 days.",
    ]);

    const splitter = new SentenceSplitter();
    expect(splitter.push("It costs 1.")).toEqual([]);
    expect(splitter.push("5 dollars.")).toEqual([]);
    expect(splitter.flush()).toEqual(["It costs 1.5 dollars."]);
  });

  it("does not split on abbreviations like Dr. and e.g.", () => {
    expect(
      feedOneByOne("Dr. Patel ordered items, e.g. tea and cups. They arrive today."),
    ).toEqual([
      "Dr. Patel ordered items, e.g. tea and cups.",
      "They arrive today.",
    ]);
  });

  it("does not split mid-sentence on ellipsis", () => {
    expect(feedOneByOne("Wait... let me check that. Yes, it shipped!")).toEqual([
      "Wait... let me check that.",
      "Yes, it shipped!",
    ]);

    const splitter = new SentenceSplitter();
    expect(splitter.push("Hold on..")).toEqual([]);
    expect(splitter.push(". okay.")).toEqual([]);
    expect(splitter.flush()).toEqual(["Hold on... okay."]);
  });

  it("handles closing quotes and brackets after terminator", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('He said "Hello!')).toEqual([]);
    expect(splitter.push('"')).toEqual([]);
    expect(splitter.push(" Then he left.")).toEqual(['He said "Hello!"']);
    expect(splitter.flush()).toEqual(["Then he left."]);

    expect(feedOneByOne("(Check order 1042.) Ready now.")).toEqual([
      "(Check order 1042.)",
      "Ready now.",
    ]);
  });

  it("flushes stream end without punctuation", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Your order is on the way")).toEqual([]);
    expect(splitter.flush()).toEqual(["Your order is on the way"]);
  });
});
