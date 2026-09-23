import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgentKitError } from '@agent-tool-platform/agent-kit';
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';

import {
  AgentSourceError,
  GeneratedOutputMismatchError,
  buildAgentRepository,
  createAgentBuild,
  loadAgentDefinition,
  locateRepositoryRoot,
  parseAgentSource,
} from '../scripts/build-agent.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultInstructions = 'Use repository evidence and remain read-only.\n';
const validSource = `schemaVersion: 1
id: fixture-agent
name: Fixture Agent
version: "1.0.0"
instructionsFile: instructions/agent.md
capabilities:
  - id: git-optimizer
  - id: ast-summarizer
`;

const createFixture = async (context, options = {}) => {
  const { source = validSource, instructionsPath } = options;
  const instructions = Object.hasOwn(options, 'instructions')
    ? options.instructions
    : defaultInstructions;
  const root = await mkdtemp(path.join(tmpdir(), 'agent-composition-fixture-'));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'agent.yaml'), source, 'utf8');

  if (instructions !== undefined) {
    const relativePath = instructionsPath ?? 'instructions/agent.md';
    const destination = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, instructions, 'utf8');
  }
  return root;
};

const adapterContent = (build, generatedPath) => {
  const file = build.adapter.files.find((candidate) => candidate.path === generatedPath);
  assert.ok(file, `Expected adapter output ${generatedPath}`);
  return file.content;
};

let repeatedBuilds;
const getRepeatedBuilds = async () => {
  repeatedBuilds ??= (async () => {
    const first = await createAgentBuild(repositoryRoot);
    const second = await createAgentBuild(repositoryRoot);
    return { first, second };
  })();
  return repeatedBuilds;
};

test('valid source becomes the canonical Agent Kit AgentDefinition', async (context) => {
  const root = await createFixture(context);
  const definition = await loadAgentDefinition(root);

  assert.deepEqual(definition, {
    schemaVersion: 1,
    id: 'fixture-agent',
    name: 'Fixture Agent',
    version: '1.0.0',
    instructions: defaultInstructions,
    capabilities: [{ id: 'ast-summarizer' }, { id: 'git-optimizer' }],
  });
});

test('instructions are loaded from the declared repository-relative file', async (context) => {
  const instructions = '# Custom instructions\n\nKeep answers concise.\n';
  const source = validSource.replace(
    'instructions/agent.md',
    'instructions/custom/primary.md',
  );
  const root = await createFixture(context, {
    source,
    instructions,
    instructionsPath: 'instructions/custom/primary.md',
  });

  const definition = await loadAgentDefinition(root);
  assert.equal(definition.instructions, instructions);
});

test('instruction line endings are normalized for cross-platform builds', async (context) => {
  const root = await createFixture(context, {
    instructions: 'First line.\r\n\r\nSecond line.\r\n',
  });

  const definition = await loadAgentDefinition(root);
  assert.equal(definition.instructions, 'First line.\n\nSecond line.\n');
});

test('malformed YAML is rejected', () => {
  assert.throws(
    () => parseAgentSource('schemaVersion: 1\ncapabilities: [\n'),
    (error) => error instanceof AgentSourceError && /Could not parse agent\.yaml/.test(error.message),
  );
});

test('unknown source fields are rejected', () => {
  assert.throws(
    () => parseAgentSource(`${validSource}runtimeImplementation: true\n`),
    (error) => error instanceof AgentSourceError && /unknown field/.test(error.message),
  );
});

test('missing agent identity is rejected', () => {
  assert.throws(
    () => parseAgentSource(validSource.replace('id: fixture-agent\n', '')),
    (error) => error instanceof AgentSourceError && /missing required field.*id/.test(error.message),
  );
});

test('unsupported YAML tags are rejected rather than evaluated', () => {
  assert.throws(
    () =>
      parseAgentSource(
        validSource.replace(
          'instructions/agent.md',
          '!!js/function "function () { return process.env; }"',
        ),
      ),
    (error) => error instanceof AgentSourceError && /unsupported YAML features/.test(error.message),
  );
});

test('a missing instructions file is rejected clearly', async (context) => {
  const root = await createFixture(context, { instructions: undefined });
  await assert.rejects(
    loadAgentDefinition(root),
    (error) => error instanceof AgentSourceError && /does not exist/.test(error.message),
  );
});

test('instructions path traversal is rejected', async (context) => {
  const source = validSource.replace('instructions/agent.md', '../outside.md');
  const root = await createFixture(context, { source, instructions: undefined });
  await assert.rejects(
    loadAgentDefinition(root),
    (error) => error instanceof AgentSourceError && /normalized path inside/.test(error.message),
  );
});

test('absolute instructions paths are rejected', async (context) => {
  const absoluteInstructions = path.resolve(tmpdir(), 'outside-agent-instructions.md');
  const source = validSource.replace(
    'instructions/agent.md',
    JSON.stringify(absoluteInstructions),
  );
  const root = await createFixture(context, { source, instructions: undefined });
  await assert.rejects(
    loadAgentDefinition(root),
    (error) => error instanceof AgentSourceError && /repository-relative/.test(error.message),
  );
});

test('duplicate capability selections are rejected', () => {
  const duplicateSource = validSource.replace(
    '  - id: ast-summarizer\n',
    '  - id: git-optimizer\n',
  );
  assert.throws(
    () => parseAgentSource(duplicateSource),
    (error) => error instanceof AgentSourceError && /duplicate capability/.test(error.message),
  );
});

test('Agent Kit schema failures propagate from canonical validation', async (context) => {
  const source = validSource.replace('version: "1.0.0"', 'version: latest');
  const root = await createFixture(context, { source });
  await assert.rejects(
    loadAgentDefinition(root),
    (error) =>
      error instanceof AgentKitError &&
      error.code === 'INVALID_AGENT_DEFINITION' &&
      /Agent definition is invalid/.test(error.message),
  );
});

test('the real published first-party Registry loads through its public API', async () => {
  const registryDocument = await loadFirstPartyCapabilityRegistry();
  const reader = createCapabilityRegistryReader(registryDocument);

  assert.equal(reader.getCapability('ast-summarizer')?.version.value, '0.1.1');
  assert.equal(reader.getCapability('git-optimizer')?.version.value, '0.1.0');
});

test('the canonical Agent Kit build resolves supported profiles and bindings', async () => {
  const { first } = await getRepeatedBuilds();

  assert.deepEqual(
    first.capabilities.map((capability) => ({
      id: capability.capability.id,
      version: capability.capability.version.value,
      profile: capability.profile.id,
      binding: capability.binding.id,
    })),
    [
      {
        id: 'ast-summarizer',
        version: '0.1.1',
        profile: 'local-package',
        binding: 'local-stdio',
      },
      {
        id: 'azure',
        version: '0.2.0',
        profile: 'hosted-read-only',
        binding: 'hosted-read-only-http',
      },
      {
        id: 'data-cruncher',
        version: '0.0.0-development',
        profile: 'local-package',
        binding: 'local-stdio',
      },
      {
        id: 'doc-rag',
        version: '0.0.0-development',
        profile: 'local-filesystem-package',
        binding: 'local-stdio',
      },
      {
        id: 'document-optimizer',
        version: '0.0.0-development',
        profile: 'local-filesystem-package',
        binding: 'local-stdio',
      },
      {
        id: 'git-optimizer',
        version: '0.1.0',
        profile: 'local-package',
        binding: 'local-stdio',
      },
      {
        id: 'vision',
        version: '0.0.0-development',
        profile: 'local-package',
        binding: 'local-stdio',
      },
    ],
  );
});

test('agent.lock is byte-identical across repeated builds', async () => {
  const { first, second } = await getRepeatedBuilds();
  assert.equal(first.lockText, second.lockText);
});

test('the VS Code agent file is byte-identical across repeated builds', async () => {
  const { first, second } = await getRepeatedBuilds();
  const generatedPath = '.github/agents/developer-optimization.agent.md';
  assert.equal(adapterContent(first, generatedPath), adapterContent(second, generatedPath));
});

test('mcp.json is byte-identical across repeated builds', async () => {
  const { first, second } = await getRepeatedBuilds();
  assert.equal(
    adapterContent(first, '.vscode/mcp.json'),
    adapterContent(second, '.vscode/mcp.json'),
  );
});

test('a write build removes only stale generated agent files', async (context) => {
  const root = await createFixture(context);
  const generatedDirectory = path.join(root, '.github', 'agents');
  const staleAgent = path.join(generatedDirectory, 'old-id.agent.md');
  const unrelatedFile = path.join(generatedDirectory, 'README.txt');
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(staleAgent, 'stale\n', 'utf8');
  await writeFile(unrelatedFile, 'keep\n', 'utf8');

  await buildAgentRepository({ repositoryRoot: root });

  await assert.rejects(access(staleAgent), (error) => error.code === 'ENOENT');
  assert.equal(await readFile(unrelatedFile, 'utf8'), 'keep\n');
  await access(path.join(generatedDirectory, 'fixture-agent.agent.md'));
});

test('check mode detects stale output without changing generated files', async (context) => {
  const root = await createFixture(context);
  await buildAgentRepository({ repositoryRoot: root });
  const lockPath = path.join(root, 'agent.lock');
  const originalLock = await readFile(lockPath);
  await writeFile(
    path.join(root, 'instructions', 'agent.md'),
    `${defaultInstructions}Additional source change.\n`,
    'utf8',
  );

  await assert.rejects(
    buildAgentRepository({ repositoryRoot: root, check: true }),
    (error) =>
      error instanceof GeneratedOutputMismatchError &&
      error.issues.includes('content differs: agent.lock'),
  );
  assert.deepEqual(await readFile(lockPath), originalLock);
});

test('repository root location is independent of the current working directory', () => {
  assert.equal(locateRepositoryRoot(), repositoryRoot);
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'build-agent.mjs'), '--check'], {
    cwd: tmpdir(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('Platform dependencies use exact registry versions and no local protocols', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const platformDependencies = Object.entries(manifest.dependencies).filter(([name]) =>
    name.startsWith('@agent-tool-platform/'),
  );

  assert.deepEqual(platformDependencies, [
    ['@agent-tool-platform/agent-kit', '0.3.0'],
    ['@agent-tool-platform/capability-registry', '0.3.0'],
  ]);
  assert.equal(manifest.dependencies['@agent-tool-platform/runtime'], undefined);
  for (const [, version] of platformDependencies) {
    assert.doesNotMatch(version, /^(?:file|link|workspace):/);
  }
});

test('package-lock pins exact public Platform packages and Agent Kit dependencies', async () => {
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const packages = lock.packages;
  const agentKit = packages['node_modules/@agent-tool-platform/agent-kit'];
  const registry = packages['node_modules/@agent-tool-platform/capability-registry'];
  const runtime = packages['node_modules/@agent-tool-platform/runtime'];

  assert.equal(packages[''].dependencies['@agent-tool-platform/agent-kit'], '0.3.0');
  assert.equal(packages[''].dependencies['@agent-tool-platform/capability-registry'], '0.3.0');
  assert.equal(agentKit.version, '0.3.0');
  assert.equal(agentKit.dependencies['@agent-tool-platform/runtime'], '0.3.0');
  assert.equal(agentKit.dependencies['@agent-tool-platform/capability-registry'], '0.3.0');
  assert.equal(registry.version, '0.3.0');
  assert.equal(runtime.version, '0.3.0');

  for (const [packagePath, metadata] of Object.entries(packages)) {
    if (packagePath.includes('node_modules/@agent-tool-platform/')) {
      assert.equal(metadata.link, undefined);
      assert.match(metadata.resolved, /^https:\/\/registry\.npmjs\.org\//);
    }
  }
});
