const input = process.argv[2];
const allowPregenerated = process.argv.includes("--allow-pregenerated");
const expected = {
  worldId: "6de26358-78e4-4ac0-bb1a-9d81e3999c4f",
  probeKey: "north-well-blue-water",
  sourceMessageJa: "北の井戸の水は、夜だけ青く光るらしい。",
};

if (!input) {
  console.error(
    "Usage: npm run verify:deployment -- https://your-amplify-domain.example",
  );
  process.exit(2);
}

const endpoint = new URL("/api/walking-skeleton", input);
const homepage = new URL("/", input);
const villageEndpoint = new URL("/api/village", input);
const scenarioEndpoint = new URL("/api/scenario", input);
const recallEndpoint = new URL("/api/recall", input);

function worldCookieFrom(response, current = "") {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  let cookie = current;
  for (const value of values) {
    const match = /^rmv_world=([^;]+)/.exec(value);
    if (match?.[1]) cookie = `rmv_world=${match[1]}`;
  }
  return cookie;
}
const homepageResponse = await fetch(homepage, {
  signal: AbortSignal.timeout(20_000),
  headers: { Accept: "text/html" },
});
const homepageHtml = await homepageResponse.text();

if (
  !homepageResponse.ok ||
  !homepageHtml.includes("Rumor Memory Village")
) {
  console.error(`The public homepage failed (${homepageResponse.status}).`);
  process.exit(1);
}

const villageResponse = await fetch(villageEndpoint, {
  signal: AbortSignal.timeout(60_000),
  headers: { Accept: "application/json" },
});
let worldCookie = worldCookieFrom(villageResponse);
let villageBody;
try {
  villageBody = await villageResponse.json();
} catch {
  console.error(
    `The village API returned a non-JSON response (${villageResponse.status}).`,
  );
  process.exit(1);
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const npcCount = Array.isArray(villageBody?.villagers)
  ? villageBody.villagers.filter((villager) => villager?.kind === "npc").length
  : 0;
const villageContractHealthy =
  villageResponse.ok &&
  uuidPattern.test(villageBody?.worldId ?? "") &&
  typeof villageBody?.simulatedAt === "string" &&
  Number.isFinite(Date.parse(villageBody.simulatedAt)) &&
  npcCount >= 5 &&
  Array.isArray(villageBody?.verdicts) &&
  Array.isArray(villageBody?.transfers) &&
  Array.isArray(villageBody?.contradictions) &&
  villageBody?.totals !== null &&
  typeof villageBody?.totals === "object" &&
  Number.isInteger(villageBody.totals.claims) &&
  villageBody.totals.claims > 0 &&
  Number.isInteger(villageBody.totals.memories) &&
  villageBody.totals.memories > 0 &&
  Number.isInteger(villageBody.totals.transfers) &&
  villageBody.totals.transfers >= 0;

if (!villageContractHealthy) {
  console.error(
    JSON.stringify(
      {
        message: "The public village API failed its minimum state contract.",
        status: villageResponse.status,
        error: villageBody?.error,
        hasWorldId: uuidPattern.test(villageBody?.worldId ?? ""),
        npcCount,
        totals: villageBody?.totals,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const scenarioDefinitionResponse = await fetch(scenarioEndpoint, {
  signal: AbortSignal.timeout(20_000),
  headers: { Accept: "application/json" },
});
const scenarioDefinition = await scenarioDefinitionResponse.json();
if (
  !scenarioDefinitionResponse.ok ||
  !Array.isArray(scenarioDefinition?.steps) ||
  scenarioDefinition.steps.length === 0
) {
  console.error("The scenario definition is unavailable.");
  process.exit(1);
}

let scenarioState;
for (let index = 0; index < scenarioDefinition.steps.length; index += 1) {
  const stepResponse = await fetch(scenarioEndpoint, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(worldCookie ? { Cookie: worldCookie } : {}),
    },
    body: JSON.stringify({ index }),
  });
  worldCookie = worldCookieFrom(stepResponse, worldCookie);
  const stepBody = await stepResponse.json();
  if (
    !stepResponse.ok ||
    stepBody?.index !== index ||
    typeof stepBody?.result?.detail !== "string" ||
    (index === scenarioDefinition.steps.length - 1 && stepBody?.done !== true)
  ) {
    console.error(
      JSON.stringify(
        {
          message: "The public scenario failed.",
          index,
          status: stepResponse.status,
          error: stepBody?.error,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  scenarioState = stepBody.state ?? scenarioState;
}

if (
  !scenarioState ||
  !Array.isArray(scenarioState.verdicts) ||
  scenarioState.verdicts.length === 0 ||
  !Array.isArray(scenarioState.transfers) ||
  scenarioState.transfers.length === 0
) {
  console.error("The scenario completed without persisted verdicts and transfers.");
  process.exit(1);
}

const recallSubject = scenarioState.verdicts[0];
const recallResponse = await fetch(recallEndpoint, {
  method: "POST",
  signal: AbortSignal.timeout(60_000),
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(worldCookie ? { Cookie: worldCookie } : {}),
  },
  body: JSON.stringify({
    npcId: recallSubject.npcId,
    topicClaimId: recallSubject.claimId,
  }),
});
const recallBody = await recallResponse.json();
const recallHealthy =
  recallResponse.ok &&
  Number.isInteger(recallBody?.candidateCount) &&
  recallBody.candidateCount > 0 &&
  Number.isInteger(recallBody?.statementLength) &&
  recallBody.statementLength > 0 &&
  recallBody.statementLength <= 16_384 &&
  Array.isArray(recallBody?.groups) &&
  recallBody.groups.length > 0 &&
  recallBody.groups.every(
    (group) =>
      typeof group?.claimId === "string" &&
      typeof group?.score === "number" &&
      Array.isArray(group?.sources),
  );
if (!recallHealthy) {
  console.error(
    JSON.stringify(
      {
        message: "The public Managed MCP recall path failed.",
        status: recallResponse.status,
        error: recallBody?.error,
        candidateCount: recallBody?.candidateCount,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const response = await fetch(endpoint, {
  signal: AbortSignal.timeout(25_000),
  headers: { Accept: "application/json" },
});
const body = await response.json();

if (!response.ok || body.ok !== true) {
  console.error(
    JSON.stringify(
      {
        status: response.status,
        ok: body.ok,
        stage: body.stage,
        error: body.error,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const expectedStages = [
  "browser",
  "amplify",
  "managed-mcp",
  "cockroachdb",
  "bedrock",
];
const actualStages = body.path?.map((entry) => entry.stage);
const allStagesHealthy = body.path?.every(
  (entry) => entry.status === "ok",
);

if (
  JSON.stringify(actualStages) !== JSON.stringify(expectedStages) ||
  !allStagesHealthy
) {
  console.error("The deployment returned an unexpected trace contract.");
  process.exit(1);
}

if (
  body.mode !== "bedrock" &&
  !(allowPregenerated && body.mode === "pregenerated")
) {
  console.error(
    `Bedrock live path was not proven (mode=${body.mode}). ` +
      "Use --allow-pregenerated only after one live deployment proof.",
  );
  process.exit(1);
}

if (
  body.contractVersion !== "walking-skeleton.v1" ||
  body.worldId !== expected.worldId ||
  body.probeKey !== expected.probeKey ||
  body.sourceMessageJa !== expected.sourceMessageJa ||
  typeof body.npcLineJa !== "string" ||
  body.npcLineJa.trim().length === 0 ||
  !response.headers.get("cache-control")?.includes("no-store")
) {
  console.error("The deployment returned unexpected fixed-scope evidence.");
  process.exit(1);
}

if (
  /CCDB1_|AKIA[0-9A-Z]{16}|secret.?key/i.test(
    JSON.stringify({
      trace: body,
      village: villageBody,
      scenario: scenarioState,
      recall: recallBody,
    }),
  )
) {
  console.error("The response appears to contain credential material.");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: response.status,
      village: {
        status: villageResponse.status,
        worldId: villageBody?.worldId,
        npcCount,
        totals: villageBody?.totals,
      },
      scenario: {
        steps: scenarioDefinition.steps.length,
        verdicts: scenarioState.verdicts.length,
        transfers: scenarioState.transfers.length,
      },
      recall: {
        status: recallResponse.status,
        candidateCount: recallBody.candidateCount,
        groups: recallBody.groups.length,
        statementLength: recallBody.statementLength,
      },
      requestId: body.requestId,
      worldId: body.worldId,
      probeKey: body.probeKey,
      mode: body.mode,
      stages: body.path,
      npcLineJa: body.npcLineJa,
    },
    null,
    2,
  ),
);
