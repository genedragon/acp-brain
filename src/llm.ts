import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const DEFAULT_MODEL = process.env.ACP_BRAIN_LLM_MODEL ?? "us.anthropic.claude-sonnet-4-20250514";

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    const region = process.env.AWS_REGION ?? "us-east-1";
    client = new BedrockRuntimeClient({ region });
  }
  return client;
}

/**
 * Generate text via Bedrock Converse API.
 * Returns the assistant's text response.
 */
export async function generateText(
  prompt: string,
  options?: {
    system?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  },
): Promise<string> {
  const command = new ConverseCommand({
    modelId: options?.model ?? DEFAULT_MODEL,
    messages: [
      {
        role: "user",
        content: [{ text: prompt }],
      },
    ],
    ...(options?.system && {
      system: [{ text: options.system }],
    }),
    inferenceConfig: {
      maxTokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.1,
    },
  });

  const response = await getClient().send(command);
  const content = response.output?.message?.content;
  if (!content || content.length === 0) {
    throw new Error("No response from Bedrock");
  }
  return content[0].text ?? "";
}
