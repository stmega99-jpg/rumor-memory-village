import "server-only";

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NOVA_LITE_INFERENCE_PROFILE_ID } from "./constants";
import type { ProbeRow } from "./types";

export async function generateNpcLine(row: ProbeRow): Promise<string> {
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? "us-east-1",
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
        modelId: NOVA_LITE_INFERENCE_PROFILE_ID,
        messages: [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
        inferenceConfig: {
          maxTokens: 80,
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
  } finally {
    client.destroy();
  }
}
