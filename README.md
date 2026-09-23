# Developer Optimization Agent

Developer Optimization Agent is a reusable Agent Tool Platform composition for software-engineering
work. Its thesis is simple: prefer specialized, bounded, evidence-preserving representations before
loading expensive raw context, while preserving task quality and falling back to raw evidence when
the optimized view is insufficient.

This repository is an **agent composition**. It defines purpose, behavior, capability selection,
routing policy, workflows, and evaluation source. It is not an MCP server, Runtime, Capability
Registry, Agent Kit, Prepare implementation, Agent Instance, or telemetry system.

## Lifecycle position

```text
Reusable Capabilities
  -> Capability Registry
  -> Canonical Agent Source (this repository)
  -> Agent Kit Build (this repository)
  -> agent.lock / bindings / VS Code adapter (this repository)
  -> Prepare later
  -> Agent Instance later
  -> M7 measurement and observability later
```

The repository was generated from
[`ashergarland/agent-composition-template`](https://github.com/ashergarland/agent-composition-template)
at source commit `1744b888d4de46158f02567e1727dde9981ec070`. Its generated initial `main`
commit is `eed4695e631b6035d0f79a2a63a2cb058070be35`; the initial content tree exactly
matches the template snapshot.

## Optimization policy

The agent operates as one developer assistant rather than a menu of MCP servers:

- gather evidence before making claims;
- narrow the decision, path, revision, symbol, data range, document, or image region first;
- prefer compact capability output before complete diffs, trees, logs, corpora, documents, or
  images;
- use only the capabilities needed for the task;
- preserve provenance and identify uncertainty or unavailable evidence;
- escalate to targeted raw source or native context when compact representations omit required
  detail;
- optimize context only when doing so preserves correctness and outcome quality; and
- investigate read-only before crossing an explicitly requested and authorized mutation boundary.

Capability-owned instructions, permissions, prerequisites, readiness, and tool contracts remain
authoritative for how each capability works. This repository owns the policy for when and why to
combine them.

## Seven-capability composition

The canonical agent composes all seven intended first-party capabilities. The installed
`@agent-tool-platform/capability-registry@0.3.0` is authoritative:

| Capability | Registry version/status | Artifact | Preferred profile and binding | M6 result |
| --- | --- | --- | --- | --- |
| AST Summarizer | `0.1.1` / `released` | published npm package | `local-package` / `local-stdio` | compatible |
| Git Optimizer | `0.1.0` / `declared` | declared npm package | `local-package` / `local-stdio` | compatible; setup required |
| Data Cruncher | `0.0.0-development` / `development` | declared npm package | `local-package` / `local-stdio` | compatible; setup required |
| Doc RAG | `0.0.0-development` / `development` | declared npm package | `local-filesystem-package` / `local-stdio` | compatible; setup required |
| Vision | `0.0.0-development` / `development` | declared npm package | `local-package` / `local-stdio` | compatible; setup required |
| Document Optimizer | `0.0.0-development` / `development` | declared npm package | `local-filesystem-package` / `local-stdio` | compatible; setup required |
| Azure | `0.2.0` / `declared` | declared OCI container | `hosted-read-only` / `hosted-read-only-http` | compatible; Prepare required |

Vision explicitly selects `local-package`: it avoids the Azure-backed profile and provider secret,
although the capability contract still permits creation of principal-scoped derived artifacts.
Azure explicitly selects `hosted-read-only`; the default agent does not select
`hosted-mutating`.

[`agent.yaml`](./agent.yaml) contains:

1. `ast-summarizer`
2. `git-optimizer`
3. `data-cruncher`
4. `doc-rag`
5. `vision` with explicit `local-package`
6. `document-optimizer`
7. `azure` with explicit `hosted-read-only`

### Azure authenticated HTTP

Platform 0.3.0 Registry schema 1.1.0 declares the Azure binding's generic HTTP client mapping from
the named `connector-api-key` configuration to the `x-api-key` request header. Agent Kit resolves
that contract and generates:

- an `azure-endpoint` prompt input;
- a password-protected `azure-connector-api-key` prompt input;
- an Azure remote HTTP server whose URL references the endpoint input; and
- an `x-api-key` header that references the secret input.

The generated adapter contains prompt references, not endpoint or credential values. Host
compatibility does not mean preparation: without a readiness snapshot Azure remains
`missing-configuration`, with its remote connection and Azure provider prerequisites still
requiring setup. Do not hand-edit [`.vscode/mcp.json`](./.vscode/mcp.json), add credentials, or
duplicate the Platform's generic HTTP adapter logic.

## Canonical source

Human-edited source:

- [`agent.yaml`](./agent.yaml) — canonical identity, version, and compatible capability selections;
- [`instructions/agent.md`](./instructions/agent.md) — agent-level behavior and orchestration;
- [`routing/workflows.yaml`](./routing/workflows.yaml) — versioned routing policy;
- [`workflows/`](./workflows/) — six compact workflow definitions; and
- [`evaluations/`](./evaluations/) — benchmark and checked-in synthetic read-only provider evidence.

[`agent.yaml`](./agent.yaml) is the only Agent Kit definition. Routing, workflows, and evaluations
are agent-owned policy/evaluation source, not competing definitions or executable orchestration.

Agent Kit 0.3.0 does **not** compile or enforce [`routing/workflows.yaml`](./routing/workflows.yaml)
or [`workflows/`](./workflows/). They exist for human review, future Builder/routing work,
evaluations, and later M7 analysis. This repository does not add a routing engine.

## Workflow source

- [`workflows/pr-commit-review.yaml`](./workflows/pr-commit-review.yaml) — bounded change review;
- [`workflows/codebase-subsystem-understanding.yaml`](./workflows/codebase-subsystem-understanding.yaml)
  — structure-first codebase orientation;
- [`workflows/failing-deployment-diagnosis.yaml`](./workflows/failing-deployment-diagnosis.yaml) —
  correlated code, configuration, provider, and operational diagnosis;
- [`workflows/large-data-investigation.yaml`](./workflows/large-data-investigation.yaml) — bounded
  reduction of logs and structured data;
- [`workflows/document-investigation.yaml`](./workflows/document-investigation.yaml) —
  progressive-fidelity document investigation; and
- [`workflows/image-screenshot-investigation.yaml`](./workflows/image-screenshot-investigation.yaml)
  — bounded OCR and visual evidence.

Each records an objective, preferred capability progression, fallback, evidence expectations,
stopping condition, and mutation boundary. None is executable orchestration machinery.

## Evaluation source

[`evaluations/pr-1842-checkout-api-deployment.yaml`](./evaluations/pr-1842-checkout-api-deployment.yaml)
defines the approved benchmark scenario: review PR 1842 and diagnose why `checkout-api` is failing.
The ground truth is the `APP_PORT` to `PORT` application change, the deployment's stale
`APP_PORT=8080`, the application's fallback to port `3000`, and TCP readiness/ingress remaining on
`8080`. The remediation is to provide `PORT=8080`; the `/health` to `/healthz` change is a false
lead because readiness is TCP.

The source defines:

- L1: AST Summarizer + Git Optimizer + Data Cruncher;
- L2: L1 + Doc RAG + Vision + Document Optimizer; and
- L3: L2 + Azure using
  [`evaluations/fixtures/checkout-api-azure-read-only.json`](./evaluations/fixtures/checkout-api-azure-read-only.json),
  a checked-in synthetic read-only provider fixture.

No benchmark measurements or superiority claims are recorded. Later M7 evaluation must hold model,
version, host, relevant instructions, budgets, cache conditions, and tool-call limits constant;
use fresh sessions; alternate baseline and optimized runs; record raw fallback; prioritize outcome
quality; and require five alternating pairs before making validated quantitative claims.

## Generated outputs

Run Agent Kit through the repository build script to generate:

- [`agent.lock`](./agent.lock) — exact releases, profiles, bindings, artifacts, source revisions,
  requirements, Registry-entry digests, and adapter version;
- [`.github/agents/developer-optimization.agent.md`](./.github/agents/developer-optimization.agent.md)
  — generated VS Code agent; and
- [`.vscode/mcp.json`](./.vscode/mcp.json) — generated VS Code MCP configuration.

Do not hand-author their semantic contents. Edit canonical source and run:

```powershell
npm run agent:build
```

The generator owns `*.agent.md` under [`.github/agents/`](./.github/agents/) and removes stale
adapters after an identity change.

## Build, test, and check

Node.js 24 is the CI target.

```powershell
npm ci
npm test
npm run agent:check
npm run agent:build
git diff --check
```

`agent:check` is intentionally non-mutating and runs before `agent:build` in CI so stale generated
artifacts cannot be repaired before validation. Repeated builds from identical source and lockfile
must be byte-identical.

## Platform dependency boundary

This independent consumer pins:

- `@agent-tool-platform/agent-kit@0.3.0`;
- `@agent-tool-platform/capability-registry@0.3.0`; and
- transitive `@agent-tool-platform/runtime@0.3.0`.

All resolve from this repository's own [`node_modules/`](./node_modules/) after `npm ci`. Platform
dependencies must never use `workspace:`, `file:`, or `link:` protocols or require a sibling
Platform checkout.

Perform future lockstep upgrades explicitly:

```powershell
npm install --save-exact @agent-tool-platform/agent-kit@X.Y.Z `
  @agent-tool-platform/capability-registry@X.Y.Z
npm test
npm run agent:check
npm run agent:build
```

Agent Kit and the Registry remain authoritative for schema validation, capability resolution,
compatibility, lock/readiness semantics, and host adapter generation. This repository copies none
of their implementation or any capability implementation.

## Readiness, Prepare, and M7 boundaries

Only AST Summarizer has a published artifact in Registry 0.3.0. Other selected local artifacts are
declared but unpublished, so the generated MCP configuration uses Agent Kit's offline launch form
and readiness remains `local-setup-required`. This is valid composition metadata, not proof that a
capability is runnable.

Azure is host-compatible but unprepared: its endpoint, `connector-api-key`, remote connection,
provider registrations, and Azure Resource Manager access are not configured here. M6 does not
install unpublished capabilities, launch servers, configure roots, provision Azure, configure
credentials, deploy providers, create Agent Instance state, or mutate private/live state. Those
are later Prepare and instance responsibilities.

M6 also does not collect telemetry, calculate token savings, claim equivalent context windows,
implement a management UI, or publish benchmark results. It provides clean policy, workflow, and
evaluation source for later M7 work.

## Public repository safety

Only reusable, account-neutral source belongs here. Do not add tenant, subscription, client, or
resource identifiers; private endpoints; production URLs; credentials; secret values; local user
paths; or operator-specific desired state. Generic secret names already present in public
capability contracts may be documented, but private/live state belongs outside this repository.
