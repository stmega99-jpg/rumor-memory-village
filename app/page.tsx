import { WalkingSkeletonClient } from "./walking-skeleton-client";

const architecture = [
  ["01", "Browser", "A visible request begins the trace."],
  ["02", "Amplify", "A server-side Next.js route owns every credential."],
  ["03", "Managed MCP", "The only runtime memory-read path."],
  ["04", "CockroachDB", "A world-scoped fact with durable provenance."],
  ["05", "Bedrock", "Nova Lite turns that fact into a villager’s line."],
];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="nav">
          <a className="wordmark" href="#top" aria-label="Rumor Memory Village">
            <span aria-hidden="true">RMV</span>
            Rumor Memory Village
          </a>
          <span className="build-tag">Walking Skeleton · v0.1</span>
        </div>

        <div className="hero-grid" id="top">
          <div>
            <p className="eyebrow">MEMORY INFRASTRUCTURE FOR LIVING WORLDS</p>
            <h1>
              Stories change.
              <br />
              Their history should not.
            </h1>
            <p className="lede">
              A durable memory substrate for agents that hear, repeat, doubt,
              and reinterpret information over time—without losing where it
              came from.
            </p>
          </div>

          <aside className="field-note" aria-label="Demonstration premise">
            <p className="note-label">DEMO PREMISE / NORTH WELL</p>
            <p lang="ja">
              「北の井戸の水が、
              <br />
              夜だけ青く光るらしい。」
            </p>
            <small>
              One seeded memory. One fixed world. Every hop observable.
            </small>
          </aside>
        </div>
      </section>

      <section className="trace-section" aria-labelledby="trace-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LIVE SYSTEM TRACE</p>
            <h2 id="trace-title">Prove the full path.</h2>
          </div>
          <p>
            This first release does one narrow thing on purpose: it proves the
            public app can read a memory only through Managed MCP, then ground
            a Bedrock response in that row.
          </p>
        </div>

        <WalkingSkeletonClient />
      </section>

      <section className="architecture" aria-labelledby="architecture-title">
        <p className="eyebrow">REQUEST PATH</p>
        <h2 id="architecture-title">Five boundaries, one observable result.</h2>
        <ol>
          {architecture.map(([number, name, description]) => (
            <li key={number}>
              <span>{number}</span>
              <div>
                <h3>{name}</h3>
                <p>{description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer>
        <span>MIT licensed · Built for the CockroachDB Hackathon</span>
        <span>Tokyo / 2026</span>
      </footer>
    </main>
  );
}
