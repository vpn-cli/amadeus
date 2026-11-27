import { z } from "zod";

export const SileroSegmentJsonSchema = z.object({
  index: z.number().int().positive(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  confirmedAtMs: z.number().nonnegative(),
  decidedAtMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  onsetConfirmMs: z.number().nonnegative(),
  vadEndMs: z.number().nonnegative(),
  endReason: z.enum(["silence", "max_duration", "flush"]),
});

export const SileroParamsJsonSchema = z.object({
  windowSamples: z.number().int().positive(),
  onsetThreshold: z.number().min(0).max(1),
  offsetThreshold: z.number().min(0).max(1),
  minSpeechMs: z.number().nonnegative(),
  endSilenceMs: z.number().nonnegative(),
  pendingGapMs: z.number().nonnegative(),
  maxSpeechMs: z.number().positive(),
});

export const SileroModelJsonSchema = z.object({
  tag: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const SileroRunJsonSchema = z.object({
  model: SileroModelJsonSchema,
  params: SileroParamsJsonSchema,
  sampleRate: z.number().int().positive(),
  durationMs: z.number().nonnegative(),
  segments: z.array(SileroSegmentJsonSchema),
});

export type SileroSegmentJson = z.infer<typeof SileroSegmentJsonSchema>;
export type SileroParamsJson = z.infer<typeof SileroParamsJsonSchema>;
export type SileroModelJson = z.infer<typeof SileroModelJsonSchema>;
export type SileroRunJson = z.infer<typeof SileroRunJsonSchema>;
