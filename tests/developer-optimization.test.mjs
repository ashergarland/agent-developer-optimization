import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AgentKitError,
  buildVsCodeAgent,
  createReadinessPlan,
  resolveAgentDefinition,
  vscodeHostAdapter,
} from '@agent-tool-platform/agent-kit';
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';
import { parse } from 'yaml';

import { loadAgentDefinition } from '../scripts/build-agent.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = createCapabilityRegistryReader(await loadFirstPartyCapabilityRegistry());

const intendedCapabilityIds = [
  'ast-summarizer',
  'azure',
  'data-cruncher',
  'doc-rag',
  'document-optimizer',
  'git-optimizer',
  'vision',
];
const canonicalCapabilityIds = intendedCapabilityIds.filter((id) => id !== 'azure');

const stageCapabilityIds = {
  A: ['ast-summarizer', 'git-optimizer', 'data-cruncher'],
  B: ['ast-summarizer', 'git-optimizer', 'data-cruncher', 'doc-rag'],
  C: [
    'ast-summarizer',
    'git-optimizer',
    'data-cruncher',
    'doc-rag',
    'vision',
    'document-optimizer',
  ],
  D: [
    'ast-summarizer',
    'git-optimizer',
    'data-cruncher',
    'doc-rag',
    'vision',
    'document-optimizer',
    'azure',
  ],
};

const stageDefinition = (stage) => ({
  schemaVersion: 1,
  id: `developer-optimization-stage-${stage.toLowerCase()}`,
  name: `Developer Optimization Stage ${stage}`,
  version: '1.0.0',
  instructions: 'Prefer compact, evidence-backed capability output before raw context.',
  capabilities: stageCapabilityIds[stage].map((id) => ({ id })),
});

const stageCache = new Map();
const getStage = async (stage) => {
  if (!stageCache.has(stage)) {
    stageCache.set(
      stage,
      (async () => {
        const definition = stageDefinition(stage);
        const resolution = await resolveAgentDefinition(definition, registry, vscodeHostAdapter);
        return {
          definition,
          resolution,
          readiness: createReadinessPlan(resolution),
        };
      })(),
    );
  }
  return stageCache.get(stage);
};

const resolvedSummary = (resolution) =>
  resolution.capabilities.map((capability) => ({
    id: capability.capability.id,
    version: capability.capability.version.value,
    status: capability.status,
    profile: capability.profile.id,
    binding:
      capability.status === 'resolved' ? capability.binding.id : capability.registryBinding.id,
    artifactAvailability:
      capability.status === 'resolved'
        ? capability.binding.artifact.availability
        : capability.artifact.availability,
    compatibility: capability.compatibility.state,
  }));

const adapterMcp = (build) => {
  const file = build.adapter.files.find((candidate) => candidate.path === '.vscode/mcp.json');
  assert.ok(file, 'Expected generated .vscode/mcp.json');
  return JSON.parse(file.content);
};

const expectedRegistry = {
  'ast-summarizer': {
    version: '0.1.1',
    status: 'released',
    artifacts: [['npm-package', 'npm', '@agent-tool-platform/ast-summarizer', 'published']],
    profiles: [['local-package', 'read-only', 'none', []]],
    bindings: [['local-stdio', 'local-package', 'stdio', 'local']],
  },
  azure: {
    version: '0.2.0',
    status: 'declared',
    artifacts: [
      ['oci-container', 'oci', 'ghcr.io/ashergarland/agent-tool-server-azure', 'declared'],
    ],
    profiles: [
      ['hosted-mutating', 'mutating', 'external', ['connector-api-key']],
      ['hosted-read-only', 'read-only', 'external', ['connector-api-key']],
    ],
    bindings: [
      ['hosted-mutating-http', 'hosted-mutating', 'http', 'remote'],
      ['hosted-read-only-http', 'hosted-read-only', 'http', 'remote'],
    ],
  },
  'data-cruncher': {
    version: '0.0.0-development',
    status: 'development',
    artifacts: [['npm-package', 'npm', 'agent-tool-server-data-cruncher', 'declared']],
    profiles: [['local-package', 'read-only', 'none', []]],
    bindings: [['local-stdio', 'local-package', 'stdio', 'local']],
  },
  'doc-rag': {
    version: '0.0.0-development',
    status: 'development',
    artifacts: [['npm-package', 'npm', 'agent-tool-server-doc-rag', 'declared']],
    profiles: [['local-filesystem-package', 'read-only', 'none', []]],
    bindings: [['local-stdio', 'local-filesystem-package', 'stdio', 'local']],
  },
  'document-optimizer': {
    version: '0.0.0-development',
    status: 'development',
    artifacts: [['npm-package', 'npm', 'agent-tool-server-document-optimizer', 'declared']],
    profiles: [['local-filesystem-package', 'read-only', 'none', []]],
    bindings: [['local-stdio', 'local-filesystem-package', 'stdio', 'local']],
  },
  'git-optimizer': {
    version: '0.1.0',
    status: 'declared',
    artifacts: [['npm-package', 'npm', 'agent-tool-server-git-optimizer', 'declared']],
    profiles: [['local-package', 'read-only', 'none', []]],
    bindings: [['local-stdio', 'local-package', 'stdio', 'local']],
  },
  vision: {
    version: '0.0.0-development',
    status: 'development',
    artifacts: [['npm-package', 'npm', 'agent-tool-server-vision', 'declared']],
    profiles: [
      ['hybrid-azure-package', 'mutating', 'external', ['AZURE_CLIENT_SECRET']],
      ['local-package', 'mutating', 'none', []],
    ],
    bindings: [
      ['hybrid-azure-stdio', 'hybrid-azure-package', 'stdio', 'hybrid'],
      ['local-stdio', 'local-package', 'stdio', 'local'],
    ],
  },
};

test('canonical identity and top-level instructions describe the real agent', async () => {
  const definition = await loadAgentDefinition(repositoryRoot);

  assert.equal(definition.id, 'developer-optimization');
  assert.equal(definition.name, 'Developer Optimization Agent');
  assert.equal(definition.version, '1.0.0');
  assert.match(definition.version, /^\d+\.\d+\.\d+$/u);
  assert.deepEqual(
    definition.capabilities.map((capability) => capability.id),
    canonicalCapabilityIds,
  );
  assert.deepEqual(
    definition.capabilities.find((capability) => capability.id === 'vision'),
    { id: 'vision', profile: 'local-package' },
  );
  assert.ok(definition.instructions.length > 2_000);
  assert.match(definition.instructions, /smallest sufficient capability sequence/u);
  assert.match(definition.instructions, /targeted raw source/u);
  assert.match(definition.instructions, /Default to read-only investigation/u);
  assert.doesNotMatch(definition.instructions, /Use the available read-only repository capabilities/u);
});

test('Registry 0.2.0 resolves every intended capability with inspected metadata', () => {
  assert.deepEqual(
    registry.listCapabilities().map((capability) => capability.id),
    intendedCapabilityIds,
  );

  for (const id of intendedCapabilityIds) {
    const capability = registry.getCapability(id);
    const expected = expectedRegistry[id];
    assert.ok(capability, `Expected Registry entry ${id}`);
    assert.equal(capability.version.value, expected.version);
    assert.equal(capability.version.status, expected.status);
    assert.deepEqual(
      capability.artifacts.map((artifact) => [
        artifact.id,
        artifact.kind,
        artifact.identifier,
        artifact.availability,
      ]),
      expected.artifacts,
    );
    assert.deepEqual(
      capability.profiles.map((profile) => [
        profile.id,
        profile.dimensions.mutation,
        profile.dimensions.provider,
        profile.prerequisites.requiredSecrets,
      ]),
      expected.profiles,
    );
    assert.deepEqual(
      capability.bindings.map((binding) => [
        binding.id,
        binding.profileId,
        binding.interface,
        binding.availability,
      ]),
      expected.bindings,
    );
    for (const profile of capability.profiles) {
      assert.equal(profile.prerequisites.setupRequired, true);
      assert.ok(profile.readiness.signals.length > 0);
    }
  }
});

test('Stage A composes AST, Git, and Data through compatible local bindings', async () => {
  const { definition, resolution, readiness } = await getStage('A');
  const build = await buildVsCodeAgent(definition, { registry });

  assert.deepEqual(resolvedSummary(resolution), [
    {
      id: 'ast-summarizer',
      version: '0.1.1',
      status: 'resolved',
      profile: 'local-package',
      binding: 'local-stdio',
      artifactAvailability: 'published',
      compatibility: 'compatible',
    },
    {
      id: 'data-cruncher',
      version: '0.0.0-development',
      status: 'resolved',
      profile: 'local-package',
      binding: 'local-stdio',
      artifactAvailability: 'declared',
      compatibility: 'compatible',
    },
    {
      id: 'git-optimizer',
      version: '0.1.0',
      status: 'resolved',
      profile: 'local-package',
      binding: 'local-stdio',
      artifactAvailability: 'declared',
      compatibility: 'compatible',
    },
  ]);
  assert.ok(readiness.capabilities.every((capability) => capability.state === 'local-setup-required'));
  assert.deepEqual(Object.keys(adapterMcp(build).servers), [
    'ast-summarizer',
    'data-cruncher',
    'git-optimizer',
  ]);
});

test('Stage B adds Doc RAG and remains a compatible deterministic VS Code build', async () => {
  const { definition, resolution, readiness } = await getStage('B');
  const first = await buildVsCodeAgent(definition, { registry });
  const second = await buildVsCodeAgent(definition, { registry });

  assert.deepEqual(
    resolvedSummary(resolution).map(({ id, version, profile, binding, compatibility }) => ({
      id,
      version,
      profile,
      binding,
      compatibility,
    })),
    [
      {
        id: 'ast-summarizer',
        version: '0.1.1',
        profile: 'local-package',
        binding: 'local-stdio',
        compatibility: 'compatible',
      },
      {
        id: 'data-cruncher',
        version: '0.0.0-development',
        profile: 'local-package',
        binding: 'local-stdio',
        compatibility: 'compatible',
      },
      {
        id: 'doc-rag',
        version: '0.0.0-development',
        profile: 'local-filesystem-package',
        binding: 'local-stdio',
        compatibility: 'compatible',
      },
      {
        id: 'git-optimizer',
        version: '0.1.0',
        profile: 'local-package',
        binding: 'local-stdio',
        compatibility: 'compatible',
      },
    ],
  );
  assert.ok(readiness.capabilities.every((capability) => capability.state === 'local-setup-required'));
  assert.equal(first.lockText, second.lockText);
  assert.deepEqual(Object.keys(adapterMcp(first).servers), [
    'ast-summarizer',
    'data-cruncher',
    'doc-rag',
    'git-optimizer',
  ]);
});

test('Stage C adds local Vision and Document Optimizer and builds successfully', async () => {
  const { definition, resolution, readiness } = await getStage('C');
  const build = await buildVsCodeAgent(definition, { registry });
  const summary = resolvedSummary(resolution);

  assert.deepEqual(summary.map((capability) => capability.id), canonicalCapabilityIds);
  assert.ok(summary.every((capability) => capability.status === 'resolved'));
  assert.ok(summary.every((capability) => capability.compatibility === 'compatible'));
  assert.deepEqual(
    summary.find((capability) => capability.id === 'vision'),
    {
      id: 'vision',
      version: '0.0.0-development',
      status: 'resolved',
      profile: 'local-package',
      binding: 'local-stdio',
      artifactAvailability: 'declared',
      compatibility: 'compatible',
    },
  );
  assert.ok(readiness.capabilities.every((capability) => capability.state === 'local-setup-required'));

  const mcp = adapterMcp(build);
  assert.equal(mcp.inputs, undefined);
  assert.deepEqual(Object.keys(mcp.servers), canonicalCapabilityIds);
  assert.deepEqual(mcp.servers['ast-summarizer'].args, [
    '-y',
    '@agent-tool-platform/ast-summarizer@0.1.1',
  ]);
  for (const id of canonicalCapabilityIds.filter((capability) => capability !== 'ast-summarizer')) {
    assert.equal(mcp.servers[id].args[0], '--offline');
  }
});

test('Stage D proves the Azure authenticated HTTP Platform incompatibility', async () => {
  const { definition, resolution, readiness } = await getStage('D');
  const azure = resolution.capabilities.find(
    (capability) => capability.capability.id === 'azure',
  );
  assert.ok(azure);
  assert.equal(azure.status, 'incompatible');
  assert.equal(azure.profile.id, 'hosted-read-only');
  assert.equal(azure.registryBinding.id, 'hosted-read-only-http');
  assert.equal(azure.artifact.availability, 'declared');
  assert.deepEqual(azure.compatibility, {
    state: 'incompatible',
    reasons: [
      'authenticated HTTP bindings require a registry-defined client header mapping that is not available',
    ],
  });

  const azureReadiness = readiness.capabilities.find((capability) => capability.id === 'azure');
  assert.ok(azureReadiness);
  assert.equal(azureReadiness.bindingMode, 'remote');
  assert.equal(azureReadiness.state, 'incompatible-binding');
  assert.ok(
    azureReadiness.requirements.some(
      (requirement) =>
        requirement.kind === 'configuration' &&
        requirement.name === 'connector-api-key' &&
        requirement.state === 'missing',
    ),
  );

  await assert.rejects(
    buildVsCodeAgent(definition, { registry }),
    (error) =>
      error instanceof AgentKitError &&
      error.code === 'INCOMPATIBLE_BINDING' &&
      error.issues.length === 1 &&
      error.issues[0] ===
        'azure@0.2.0/hosted-read-only: authenticated HTTP bindings require a registry-defined client header mapping that is not available',
  );
});

test('safe profile policy prefers local Vision and read-only Azure', async () => {
  const { resolution: stageC } = await getStage('C');
  const { resolution: stageD } = await getStage('D');
  const vision = stageC.capabilities.find(
    (capability) => capability.capability.id === 'vision',
  );
  const azure = stageD.capabilities.find(
    (capability) => capability.capability.id === 'azure',
  );

  assert.equal(vision?.profile.id, 'local-package');
  assert.equal(vision?.profile.dimensions.provider, 'none');
  assert.equal(azure?.profile.id, 'hosted-read-only');
  assert.equal(azure?.profile.dimensions.mutation, 'read-only');
});

test('all seven intended capability identities are accounted for without faking Azure support', async () => {
  const agentSource = await readFile(path.join(repositoryRoot, 'agent.yaml'), 'utf8');
  const routing = parse(
    await readFile(path.join(repositoryRoot, 'routing', 'workflows.yaml'), 'utf8'),
  );
  const benchmark = parse(
    await readFile(
      path.join(repositoryRoot, 'evaluations', 'pr-1842-checkout-api-deployment.yaml'),
      'utf8',
    ),
  );

  assert.deepEqual(Object.keys(routing.capabilityRoles).sort(), intendedCapabilityIds);
  assert.deepEqual([...benchmark.levels.L3.capabilities].sort(), intendedCapabilityIds);
  assert.match(agentSource, /Azure is an intended capability/u);
  assert.doesNotMatch(
    agentSource,
    /^\s*-\s+id:\s+azure\s*$/mu,
    'Azure must not be selected until Agent Kit can adapt its authenticated HTTP binding',
  );
});

test('routing policy is complete source and explicitly not runtime-enforced', async () => {
  const routing = parse(
    await readFile(path.join(repositoryRoot, 'routing', 'workflows.yaml'), 'utf8'),
  );

  assert.equal(routing.agentId, 'developer-optimization');
  assert.equal(routing.runtimeEnforced, false);
  assert.match(routing.boundary, /Agent Kit 0\.2\.0 does not compile or enforce/u);
  assert.deepEqual(
    routing.routes.map((route) => route.id),
    [
      'pr-or-commit-review',
      'codebase-or-subsystem-understanding',
      'large-log-or-structured-output',
      'document-investigation',
      'image-or-screenshot-investigation',
      'azure-diagnosis',
    ],
  );
});

test('six compact workflow definitions carry the required policy seams', async () => {
  const workflowDirectory = path.join(repositoryRoot, 'workflows');
  const expectedFiles = [
    'codebase-subsystem-understanding.yaml',
    'document-investigation.yaml',
    'failing-deployment-diagnosis.yaml',
    'image-screenshot-investigation.yaml',
    'large-data-investigation.yaml',
    'pr-commit-review.yaml',
  ];
  assert.deepEqual((await readdir(workflowDirectory)).sort(), expectedFiles);

  for (const fileName of expectedFiles) {
    const workflow = parse(await readFile(path.join(workflowDirectory, fileName), 'utf8'));
    assert.equal(workflow.kind, 'developer-optimization-workflow');
    assert.equal(workflow.agentId, 'developer-optimization');
    assert.equal(workflow.runtimeEnforced, false);
    assert.ok(workflow.objective.length > 20);
    assert.ok(workflow.preferredProgression.length > 0);
    assert.ok(workflow.fallback.condition.length > 20);
    assert.ok(workflow.fallback.action.length > 20);
    assert.ok(workflow.evidenceExpectations.length > 0);
    assert.ok(workflow.stoppingCondition.length > 20);
    assert.ok(workflow.mutationBoundary.length > 20);
  }
});

test('benchmark source preserves the checkout-api ground-truth invariants', async () => {
  const benchmark = parse(
    await readFile(
      path.join(repositoryRoot, 'evaluations', 'pr-1842-checkout-api-deployment.yaml'),
      'utf8',
    ),
  );

  assert.equal(
    benchmark.scenario,
    'Review PR 1842 and diagnose why the checkout-api deployment is failing.',
  );
  assert.deepEqual(benchmark.groundTruth.applicationChange.before, {
    environmentVariable: 'APP_PORT',
    deployedDefault: 8080,
  });
  assert.deepEqual(benchmark.groundTruth.applicationChange.after, {
    environmentVariable: 'PORT',
    localDefault: 3000,
  });
  assert.deepEqual(benchmark.groundTruth.deploymentConfiguration, {
    environmentVariable: 'APP_PORT',
    value: 8080,
  });
  assert.equal(benchmark.groundTruth.runtime.effectiveListenPort, 3000);
  assert.deepEqual(benchmark.groundTruth.readiness, { protocol: 'TCP', port: 8080 });
  assert.equal(benchmark.groundTruth.ingress.port, 8080);
  assert.deepEqual(benchmark.groundTruth.remediation, {
    changeDeploymentEnvironmentName: { from: 'APP_PORT', to: 'PORT' },
    retainDeploymentValue: 8080,
    retainReadinessPort: 8080,
    retainIngressPort: 8080,
  });
  assert.equal(benchmark.groundTruth.falseLead.change, '/health -> /healthz');
  assert.match(benchmark.groundTruth.falseLead.reason, /readiness probe is TCP/u);
  assert.deepEqual(benchmark.levels.L1.capabilities, [
    'ast-summarizer',
    'git-optimizer',
    'data-cruncher',
  ]);
  assert.equal(
    benchmark.levels.L3.providerEvidence.path,
    'fixtures/checkout-api-azure-read-only.json',
  );
  assert.equal(benchmark.levels.L3.providerEvidence.liveMutation, false);
  assert.equal(
    benchmark.controlledEvaluationContract.validatedQuantitativeClaims
      .minimumAlternatingBaselineOptimizedPairs,
    5,
  );
  assert.match(
    benchmark.controlledEvaluationContract.validatedQuantitativeClaims.currentStatus,
    /No measurements or superiority claims/u,
  );

  const providerEvidence = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        'evaluations',
        'fixtures',
        'checkout-api-azure-read-only.json',
      ),
      'utf8',
    ),
  );
  assert.equal(providerEvidence.live, false);
  assert.equal(providerEvidence.mutationAllowed, false);
  assert.equal(providerEvidence.observations.environment.APP_PORT, '8080');
  assert.equal(providerEvidence.observations.readinessProbe.protocol, 'TCP');
  assert.equal(providerEvidence.observations.readinessProbe.port, 8080);
  assert.match(providerEvidence.observations.processLog, /listening on 3000/u);
});

test('stale repository-context product identity and adapter are absent', async () => {
  await assert.rejects(
    access(
      path.join(repositoryRoot, '.github', 'agents', 'repository-context.agent.md'),
    ),
    (error) => error.code === 'ENOENT',
  );

  const productFiles = [
    'README.md',
    'agent.yaml',
    'agent.lock',
    'package.json',
    'package-lock.json',
    'instructions/agent.md',
    'routing/workflows.yaml',
    '.github/agents/developer-optimization.agent.md',
    '.vscode/mcp.json',
  ];
  for (const relativePath of productFiles) {
    const content = await readFile(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
    assert.doesNotMatch(content, /repository-context|Repository Context/u, relativePath);
  }
});

test('tracked product source contains no private or credential-shaped state', async () => {
  const sourceFiles = [
    'README.md',
    'agent.yaml',
    'agent.lock',
    'instructions/agent.md',
    'routing/workflows.yaml',
    '.github/agents/developer-optimization.agent.md',
    '.vscode/mcp.json',
    ...(await readdir(path.join(repositoryRoot, 'workflows'))).map(
      (fileName) => `workflows/${fileName}`,
    ),
    'evaluations/pr-1842-checkout-api-deployment.yaml',
    'evaluations/fixtures/checkout-api-azure-read-only.json',
  ];
  const forbidden = [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    /\/subscriptions\//iu,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u,
    /(?:api[_ -]?key|client[_ -]?secret|password)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{8,}/iu,
    /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/iu,
    /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^/\s\\]+/u,
  ];

  for (const relativePath of sourceFiles) {
    const content = await readFile(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${relativePath} matched ${pattern}`);
    }
  }
});

test('Platform packages resolve at exact versions from this repository node_modules', async () => {
  const packages = [
    ['@agent-tool-platform/agent-kit', 'agent-kit', '0.2.0'],
    ['@agent-tool-platform/capability-registry', 'capability-registry', '0.2.0'],
    ['@agent-tool-platform/runtime', 'runtime', '0.2.0'],
  ];

  for (const [packageName, directoryName, expectedVersion] of packages) {
    const resolved = fileURLToPath(import.meta.resolve(packageName));
    const expectedRoot = path.join(
      repositoryRoot,
      'node_modules',
      '@agent-tool-platform',
      directoryName,
    );
    assert.ok(resolved.startsWith(expectedRoot), `${packageName} resolved outside this repository`);
    const manifest = JSON.parse(
      await readFile(path.join(expectedRoot, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.version, expectedVersion);
  }
});

test('CI retains Node 24 and checks stale outputs before rebuilding', async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  assert.match(workflow, /node-version:\s*24/u);
  assert.ok(
    workflow.indexOf('npm run agent:check') < workflow.indexOf('npm run agent:build'),
    'agent:check must run before agent:build',
  );
  assert.match(
    workflow,
    /git diff --exit-code -- agent\.lock \.github\/agents \.vscode\/mcp\.json/u,
  );
  assert.match(workflow, /git diff --check/u);
});
