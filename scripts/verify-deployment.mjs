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

if (/CCDB1_|AKIA[0-9A-Z]{16}|secret.?key/i.test(JSON.stringify(body))) {
  console.error("The response appears to contain credential material.");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: response.status,
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
