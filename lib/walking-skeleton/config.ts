import "server-only";

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { COCKROACH_CLUSTER_ID } from "./constants";

export interface RuntimeSecrets {
  cockroachMcpApiKey: string;
  cockroachClusterId: string;
  cockroachSqlUrl: string;
  /** Independent HMAC key for the per-visitor world cookie. */
  worldCookieSecret: string;
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

function isCockroachSqlUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "postgresql:" || parsed.protocol === "postgres:") &&
      parsed.hostname.length > 0 &&
      parsed.username.length > 0 &&
      parsed.password.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Validate the complete server-side secret contract without ever echoing a
 * rejected value. Exported so configuration failures can be covered without
 * contacting Secrets Manager.
 */
export function validateRuntimeSecrets(value: unknown): RuntimeSecrets {
  if (typeof value !== "object" || value === null) {
    throw new RuntimeConfigurationError();
  }

  const candidate = value as Record<string, unknown>;
  const cockroachMcpApiKey = candidate.cockroachMcpApiKey;
  const cockroachClusterId = candidate.cockroachClusterId;
  const cockroachSqlUrl = candidate.cockroachSqlUrl;
  const worldCookieSecret = candidate.worldCookieSecret;

  if (
    typeof cockroachMcpApiKey !== "string" ||
    cockroachMcpApiKey.length < 16 ||
    typeof cockroachClusterId !== "string" ||
    cockroachClusterId !== COCKROACH_CLUSTER_ID ||
    !isCockroachSqlUrl(cockroachSqlUrl) ||
    typeof worldCookieSecret !== "string" ||
    Buffer.byteLength(worldCookieSecret, "utf8") < 32 ||
    worldCookieSecret !== worldCookieSecret.trim() ||
    worldCookieSecret === cockroachMcpApiKey ||
    worldCookieSecret === cockroachSqlUrl
  ) {
    throw new RuntimeConfigurationError();
  }

  return {
    cockroachMcpApiKey,
    cockroachClusterId,
    cockroachSqlUrl,
    worldCookieSecret,
  };
}

function loadLocalSecrets(): RuntimeSecrets | undefined {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.RMV_ALLOW_ENV_SECRETS !== "true"
  ) {
    return undefined;
  }

  return validateRuntimeSecrets({
    cockroachMcpApiKey: process.env.RMV_COCKROACH_MCP_API_KEY,
    cockroachClusterId: process.env.RMV_COCKROACH_CLUSTER_ID,
    cockroachSqlUrl: process.env.RMV_COCKROACH_SQL_URL,
    worldCookieSecret: process.env.RMV_WORLD_COOKIE_SECRET,
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

    return validateRuntimeSecrets(JSON.parse(raw) as unknown);
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
