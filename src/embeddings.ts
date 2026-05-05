import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const EMBEDDING_MODEL_ID = "amazon.nova-2-multimodal-embeddings-v1:0";
const EMBEDDING_DIMENSION = 1024;

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    const region = process.env.AWS_REGION ?? "us-east-1";
    client = new BedrockRuntimeClient({ region });
  }
  return client;
}

/**
 * Generate a 1024-dimensional embedding for the given text using
 * Amazon Nova Multimodal Embeddings via Bedrock.
 *
 * Uses the Nova 2 schema: schemaVersion "nova-multimodal-embed-v1",
 * taskType "SINGLE_EMBEDDING", with embeddingPurpose "GENERIC_INDEX"
 * for storage and "GENERIC_RETRIEVAL" for search queries.
 */
export async function generateEmbedding(
  text: string,
  purpose: "GENERIC_INDEX" | "GENERIC_RETRIEVAL" = "GENERIC_INDEX",
): Promise<number[]> {
  const body = JSON.stringify({
    schemaVersion: "nova-multimodal-embed-v1",
    taskType: "SINGLE_EMBEDDING",
    singleEmbeddingParams: {
      embeddingPurpose: purpose,
      embeddingDimension: EMBEDDING_DIMENSION,
      text: {
        truncationMode: "END",
        value: text,
      },
    },
  });

  const command = new InvokeModelCommand({
    modelId: EMBEDDING_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(body),
  });

  const response = await getClient().send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embeddings[0].embedding as number[];
}

/**
 * Format a number[] embedding into the pgvector literal format: [0.1,0.2,...]
 */
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
