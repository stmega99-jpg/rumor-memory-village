import "server-only";

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { COCKROACH_CLUSTER_ID } from "./constants";

export interface RuntimeSecrets {
  cockroachMcpApiKey: string;
  cockroachClusterId: string;
}

export class RuntimeConfigurationError extends Error {
  constructor() {
    super("Runtime configuration is unavailable.");
    this.name = "RuntimeConfigurationError";
  }
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1_000;

let cachedSecrets:
  | {
      value: RuntimeSecrets;
      expiresAt: number;
    }
  | undefined;
let secretsInFlight: Promise<RuntimeSecrets> | undefined;

function validateSecrets(value: unknown): RuntimeSecrets {
  if (typeof value !== "object" || value === null) {
    throw new RuntimeConfigurationError();
  }

  const candidate = value as Record<string, unknown>;
  const cockroachMcpApiKey = candidate.cockroachMcpApiKey;
  const cockroachClusterId = candidate.cockroachClusterId;

  if (
    typeof cockroachMcpApiKey !== "string" ||
    cockroachMcpApiKey.length < 16 ||
    typeof cockroachClusterId !== "string" ||
    cockroachClusterId !== COCKROACH_CLUSTER_ID
  ) {
    throw new RuntimeConfigurationError();
  }

  return { cockroachMcpApiKey, cockroachClusterId };
}

function loadLocalSecrets(): RuntimeSecrets | undefined {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.RMV_ALLOW_ENV_SECRETS !== "true"
  ) {
    return undefined;
  }

  return validateSecrets({
    cockroachMcpApiKey: process.env.RMV_COCKROACH_MCP_API_KEY,
    cockroachClusterId: process.env.RMV_COCKROACH_CLUSTER_ID,
  });
}

async function fetchSecrets(): Promise<RuntimeSecrets> {
  const localSecrets = loadLocalSecrets();
  if (localSecrets) {
    return localSecrets;
  }

  const region = process.env.AWS_REGION ?? "us-east-1";
  const secretId =
    process.env.RMV_SECRET_ID ?? "rumor-memory-village/prod";
  const client = new SecretsManagerClient({ region });

  try {
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
      {
        abortSignal: AbortSignal.timeout(5_000),
      },
    );
    const raw =
      response.SecretString ??
      (response.SecretBinary
        ? Buffer.from(response.SecretBinary).toString("utf8")
        : undefined);

    if (!raw) {
      throw new RuntimeConfigurationError();
    }

    return validateSecrets(JSON.parse(raw) as unknown);
  } catch {
    throw new RuntimeConfigurationError();
  } finally {
    client.destroy();
  }
}

export async function getRuntimeSecrets(): Promise<RuntimeSecrets> {
  if (cachedSecrets && cachedSecrets.expiresAt > Date.now()) {
    return cachedSecrets.value;
  }

  secretsInFlight ??= fetchSecrets()
    .then((value) => {
      cachedSecrets = {
        value,
        expiresAt: Date.now() + SECRET_CACHE_TTL_MS,
      };
      return value;
    })
    .finally(() => {
      secretsInFlight = undefined;
    });

  return secretsInFlight;
}
