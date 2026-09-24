import { z } from "zod";

export const radarSignalV1Schema = z.object({
  schemaVersion: z.literal("1"),
  signalId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
  token: z.object({
    chain: z.string().trim().min(1),
    contractAddress: z.string().trim().min(1),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    imageUrl: z.url().nullable(),
  }).strict(),
  category: z.enum(["new_token_discovery", "old_token_momentum"]),
  broadcastSequence: z.number().int().positive(),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  marketCapUsd: z.number().nonnegative().nullable(),
  priceUsd: z.number().nonnegative().nullable(),
  triggeredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  display: z.object({
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    reasonCodes: z.array(z.string().trim().min(1)),
  }).strict(),
}).strict().superRefine((signal, context) => {
  if (Date.parse(signal.expiresAt) <= Date.parse(signal.triggeredAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must follow triggeredAt" });
  }
});

type ParsedRadarSignalV1 = z.infer<typeof radarSignalV1Schema>;

export type RadarSignalV1 = Readonly<
  Omit<ParsedRadarSignalV1, "token" | "display"> & {
    token: Readonly<ParsedRadarSignalV1["token"]>;
    display: Readonly<
      Omit<ParsedRadarSignalV1["display"], "reasonCodes"> & {
        reasonCodes: readonly string[];
      }
    >;
  }
>;
