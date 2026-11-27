import { describe, expect, it } from "vitest";
import { formatReportedTrackSettings, isAudioProcessingEnabled } from "./processing.js";

describe("processing query param and track settings formatting", () => {
  it("enables audio processing by default and for ?processing=on, disables for ?processing=off", () => {
    expect(isAudioProcessingEnabled("")).toBe(true);
    expect(isAudioProcessingEnabled("?processing=on")).toBe(true);
    expect(isAudioProcessingEnabled("?foo=bar")).toBe(true);
    expect(isAudioProcessingEnabled("?processing=off")).toBe(false);
    expect(isAudioProcessingEnabled("?foo=1&processing=off")).toBe(false);
  });

  it("formats reported track settings including missing fields as n/a", () => {
    expect(
      formatReportedTrackSettings({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
      }),
    ).toEqual({
      echoCancellation: "false",
      noiseSuppression: "false",
      autoGainControl: "false",
      channelCount: "2",
      sampleRate: "48000 Hz",
    });

    expect(formatReportedTrackSettings(undefined)).toEqual({
      echoCancellation: "n/a",
      noiseSuppression: "n/a",
      autoGainControl: "n/a",
      channelCount: "n/a",
      sampleRate: "n/a",
    });
  });
});
