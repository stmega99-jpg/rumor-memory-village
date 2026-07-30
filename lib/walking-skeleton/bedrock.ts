import "server-only";

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NOVA_LITE_MODEL_ID } from "./constants";
import type { ProbeRow } from "./types";

export async function generateNpcLine(row: ProbeRow): Promise<string> {
  const region =
    process.env.RMV_BEDROCK_REGION ??
    process.env.AWS_REGION ??
    "ap-northeast-1";
  const client = new BedrockRuntimeClient({
    region,
  });

  const prompt = [
    "You are a villager recalling one grounded rumor.",
    "Write exactly one short, natural Japanese sentence.",
    "Do not add facts that are not present in the database message.",
    `Database message: ${row.messageJa}`,
  ].join("\n");

  try {
    const response = await client.send(
      new ConverseCommand({
        modelId: NOVA_LITE_MODEL_ID,
        messages: [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
        inferenceConfig: {
          maxTokens: 32,
          temperature: 0.2,
          topP: 0.9,
        },
      }),
      {
        abortSignal: AbortSignal.timeout(8_000),
      },
    );

    const text = response.output?.message?.content?.find(
      (block) => "text" in block,
    )?.text;

    if (!text?.trim()) {
      throw new Error("Bedrock returned no text.");
    }

    return text.trim();
  } catch (error) {
    const metadata =
      typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        : undefined;
    console.error(
      `[walking-skeleton] bedrock error=${
        error instanceof Error ? error.name : "UnknownError"
      } status=${metadata?.httpStatusCode ?? "unknown"} region=${region}`,
    );
    throw error;
  } finally {
    client.destroy();
  }
}
