# Rumor Memory Village

Rumor Memory Village is a durable memory layer for multi-agent worlds. The
v0.1 Walking Skeleton deliberately implements one narrow, observable path:

```text
Browser → AWS Amplify (Next.js API) → CockroachDB Cloud Managed MCP
        → CockroachDB seed row → Amazon Bedrock Nova Lite → Browser
```

The public API never reads CockroachDB through direct SQL. A Managed MCP
failure fails closed. A Bedrock failure may return a clearly labelled,
deterministic template fallback.

## Current scope

- One fixed `world_id` and one fixed probe key
- One read-only `select_query` call through CockroachDB Cloud Managed MCP
- One non-streaming Nova Lite smoke call grounded in the returned row
- A Nova Lite line pre-generated into CockroachDB for the public demo path
- A visible per-boundary trace
- No claim/memory/belief simulation yet

See [`SPEC_FOR_SOL.md`](./SPEC_FOR_SOL.md) for the frozen implementation
specification.

## Requirements

- Node.js 24
- npm
- CockroachDB Cloud Basic cluster
- AWS account with Amazon Bedrock access in the configured runtime Region
- AWS Amplify Hosting with an SSR Compute Role

## Local checks

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

The page can be developed locally with `npm run dev`. The API needs either AWS
Secrets Manager access through the local AWS credential chain, or the explicit
local-only environment opt-in documented in `.env.example`.

Never commit `.env` files or credentials.

## Database bootstrap

Run [`db/walking-skeleton.sql`](./db/walking-skeleton.sql) through an
authenticated CockroachDB SQL session. It creates the
`rumor_memory_village` database, the world-scoped source table, a safe-column
MCP projection table, and idempotent seed rows.

Direct SQL is permitted here because this is a controlled migration/write
operation. It is not a runtime read fallback.

## Runtime secret

Create an AWS Secrets Manager JSON secret named
`rumor-memory-village/prod`:

```json
{
  "cockroachMcpApiKey": "<CockroachDB service-account secret key>",
  "cockroachClusterId": "dcd3153f-e8af-4509-a796-b4f160170270"
}
```

The CockroachDB credential should belong to an application-specific service
account scoped to the target cluster. The key is shown only once; place it
directly into Secrets Manager and do not save it in the repository, Amplify
build variables, screenshots, or logs.

## AWS roles

Use separate roles for Amplify build/deployment and SSR runtime:

- **Amplify service role:** only the permissions Amplify needs to build and
  publish the app.
- **SSR Compute Role:** `secretsmanager:GetSecretValue` on the exact runtime
  secret plus `bedrock:InvokeModel` on the exact Nova Lite model resource in
  `RMV_BEDROCK_REGION`.

Attach the compute role only to the production branch. Titan Text Embeddings
v2 permission will be added when the embedding path is implemented; the
Walking Skeleton does not request unused permissions.

The application does not accept explicit AWS access keys. The AWS SDK uses the
SSR Compute Role credential chain at runtime.

No NAT Gateway is created. For this time-bounded demo, the CockroachDB public
endpoint remains network-accessible and security is enforced with TLS,
application-specific authentication, least privilege, and AWS Secrets Manager.
A production deployment should additionally narrow network access where its
hosting topology permits.

## Amplify

`amplify.yml` pins the build to Node.js 24 and produces the standard `.next`
artifact. Configure this non-secret build variable on the Amplify app:

```text
RMV_LIVE_BEDROCK_PROBE=false
RMV_BEDROCK_REGION=us-east-1
```

`amplify.yml` copies these settings into `.env.production` so they reach the
SSR runtime. The Secrets Manager Region and secret name remain frozen to
`us-east-1` and `rumor-memory-village/prod` in server-only defaults;
`RMV_BEDROCK_REGION` can independently select a Region with available Nova
Lite quota.

For the first deployment only, set `RMV_LIVE_BEDROCK_PROBE=true`, deploy, and
run the verifier. After it reports `mode=bedrock`, set the value back to
`false` and redeploy. The stable public path then returns the database's
pre-generated Nova Lite line, avoiding a model charge for every anonymous
click. The API response itself stays `no-store`: each visible trace therefore
still proves a fresh Amplify → Managed MCP → CockroachDB read.

Attach the SSR Compute Role in Amplify Hosting before validating the API.
Next.js streaming is intentionally not used because Amplify Hosting does not
support it.

Verify a deployment with:

```bash
npm run verify:deployment -- https://your-amplify-domain.example
```

After the one-time live proof, verify the stable public deployment with:

```bash
npm run verify:deployment -- https://your-amplify-domain.example --allow-pregenerated
```

## Security invariants

- All credentials are server-only; nothing secret uses `NEXT_PUBLIC_`.
- The browser supplies neither SQL nor `world_id`.
- The MCP query is compiled from fixed server constants and includes
  `LIMIT 1`.
- MCP responses are rejected unless they contain exactly the expected
  world-scoped row.
- Runtime MCP reads select only from a safe-column projection table.
- MCP errors are not serialized or logged.
- `truth_value` is not selected or exposed.
- There is no direct-SQL runtime read fallback.

### Managed MCP authorization boundary

CockroachDB Cloud currently requires a Managed MCP service account to have
`Cluster Operator` or `Cluster Admin` on the target cluster. Cloud roles and
SQL roles are separate, so the `rmv_mcp_read` SQL role created by the migration
cannot be attached to that Managed MCP service identity.

The application therefore enforces the product boundary that is actually
available: the service account is scoped to one cluster, the
`mcp-cluster-id` header pins that cluster, the browser cannot submit SQL or a
world id, the server uses one fixed query, and that query selects a
safe-column projection table whose `CHECK` constraint accepts only the fixed
demo `world_id`. The unused SQL role records the intended
least-privilege contract for a future Managed MCP version that supports
SQL-role binding.

A compromised Managed MCP service-account key would still have the broader
Cloud-role permissions, so key rotation and Secrets Manager protection remain
mandatory.

## License

[MIT](./LICENSE)
