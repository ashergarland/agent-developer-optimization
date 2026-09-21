import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildVsCodeAgent, parseAgentDefinition } from '@agent-tool-platform/agent-kit';
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';
import { parseDocument } from 'yaml';

export const AGENT_SOURCE_SCHEMA_VERSION = 1;
export const GENERATED_AGENT_DIRECTORY = '.github/agents';

const AGENT_SOURCE_FILENAME = 'agent.yaml';
const GENERATED_AGENT_SUFFIX = '.agent.md';
const LOCK_PATH = 'agent.lock';
const MCP_PATH = '.vscode/mcp.json';
const SOURCE_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'version',
  'instructionsFile',
  'capabilities',
];
const CAPABILITY_KEYS = ['id', 'version', 'profile'];

export class AgentSourceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AgentSourceError';
  }
}

export class GeneratedOutputMismatchError extends Error {
  constructor(issues) {
    super(
      `Generated outputs are stale:\n- ${issues.join(
        '\n- ',
      )}\nRun "npm run agent:build" and review the generated diff.`,
    );
    this.name = 'GeneratedOutputMismatchError';
    this.issues = issues;
  }
}

const isRecord = (value) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const assertRecord = (value, label) => {
  if (!isRecord(value)) {
    throw new AgentSourceError(`${label} must be a mapping.`);
  }
};

const assertKnownKeys = (value, allowed, required, label) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AgentSourceError(`${label} contains unknown field(s): ${unknown.join(', ')}.`);
  }

  const missing = required.filter((key) => !own(value, key));
  if (missing.length > 0) {
    throw new AgentSourceError(`${label} is missing required field(s): ${missing.join(', ')}.`);
  }
};

const assertNonEmptyString = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentSourceError(`${label} must be a non-empty string.`);
  }
};

const parseCapabilitySelections = (value) => {
  if (!Array.isArray(value)) {
    throw new AgentSourceError('agent.yaml capabilities must be a sequence.');
  }

  const seen = new Set();
  return value.map((selection, index) => {
    const label = `agent.yaml capabilities[${index}]`;
    assertRecord(selection, label);
    assertKnownKeys(selection, CAPABILITY_KEYS, ['id'], label);
    assertNonEmptyString(selection.id, `${label}.id`);

    if (seen.has(selection.id)) {
      throw new AgentSourceError(
        `agent.yaml contains duplicate capability selection "${selection.id}".`,
      );
    }
    seen.add(selection.id);

    if (own(selection, 'version')) {
      assertNonEmptyString(selection.version, `${label}.version`);
    }
    if (own(selection, 'profile')) {
      assertNonEmptyString(selection.profile, `${label}.profile`);
    }

    return {
      id: selection.id,
      ...(own(selection, 'version') ? { version: selection.version } : {}),
      ...(own(selection, 'profile') ? { profile: selection.profile } : {}),
    };
  });
};

const formatYamlDiagnostics = (diagnostics) =>
  diagnostics.map((diagnostic) => diagnostic.message).join('; ');

export const parseAgentSource = (yamlText, sourceLabel = AGENT_SOURCE_FILENAME) => {
  let document;
  try {
    document = parseDocument(yamlText, {
      schema: 'core',
      merge: false,
      prettyErrors: true,
      uniqueKeys: true,
      version: '1.2',
    });
  } catch (error) {
    throw new AgentSourceError(`Could not parse ${sourceLabel}: ${error.message}`, {
      cause: error,
    });
  }

  if (document.errors.length > 0) {
    throw new AgentSourceError(
      `Could not parse ${sourceLabel}: ${formatYamlDiagnostics(document.errors)}`,
    );
  }
  if (document.warnings.length > 0) {
    throw new AgentSourceError(
      `${sourceLabel} uses unsupported YAML features: ${formatYamlDiagnostics(document.warnings)}`,
    );
  }

  let source;
  try {
    source = document.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw new AgentSourceError(`Could not materialize ${sourceLabel}: ${error.message}`, {
      cause: error,
    });
  }

  assertRecord(source, sourceLabel);
  assertKnownKeys(source, SOURCE_KEYS, SOURCE_KEYS, sourceLabel);

  if (source.schemaVersion !== AGENT_SOURCE_SCHEMA_VERSION) {
    throw new AgentSourceError(
      `${sourceLabel}.schemaVersion must be ${AGENT_SOURCE_SCHEMA_VERSION}.`,
    );
  }
  assertNonEmptyString(source.id, `${sourceLabel}.id`);
  assertNonEmptyString(source.name, `${sourceLabel}.name`);
  assertNonEmptyString(source.version, `${sourceLabel}.version`);
  assertNonEmptyString(source.instructionsFile, `${sourceLabel}.instructionsFile`);

  return {
    schemaVersion: source.schemaVersion,
    id: source.id,
    name: source.name,
    version: source.version,
    instructionsFile: source.instructionsFile,
    capabilities: parseCapabilitySelections(source.capabilities),
  };
};

const isWithinRepository = (repositoryRoot, candidate) => {
  const relative = path.relative(repositoryRoot, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const normalizeSourcePath = (sourcePath) => {
  if (path.posix.isAbsolute(sourcePath) || path.win32.isAbsolute(sourcePath)) {
    throw new AgentSourceError('agent.yaml instructionsFile must be repository-relative.');
  }

  const normalized = sourcePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\0'),
    )
  ) {
    throw new AgentSourceError(
      'agent.yaml instructionsFile must be a normalized path inside the repository.',
    );
  }

  return segments;
};

const readInstructions = async (repositoryRoot, sourcePath) => {
  const pathSegments = normalizeSourcePath(sourcePath);
  const candidate = path.resolve(repositoryRoot, ...pathSegments);
  if (!isWithinRepository(repositoryRoot, candidate)) {
    throw new AgentSourceError('agent.yaml instructionsFile resolves outside the repository.');
  }

  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new AgentSourceError(`Instructions file does not exist: ${sourcePath}`, {
        cause: error,
      });
    }
    throw error;
  }

  if (!isWithinRepository(repositoryRoot, resolved)) {
    throw new AgentSourceError('agent.yaml instructionsFile resolves outside the repository.');
  }

  const details = await stat(resolved);
  if (!details.isFile()) {
    throw new AgentSourceError(`Instructions path is not a file: ${sourcePath}`);
  }

  const instructions = await readFile(resolved, 'utf8');
  return instructions.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
};

export const locateRepositoryRoot = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const loadAgentDefinition = async (repositoryRoot = locateRepositoryRoot()) => {
  const root = await realpath(path.resolve(repositoryRoot));
  const sourcePath = path.join(root, AGENT_SOURCE_FILENAME);
  const source = parseAgentSource(await readFile(sourcePath, 'utf8'), AGENT_SOURCE_FILENAME);
  const instructions = await readInstructions(root, source.instructionsFile);

  return parseAgentDefinition({
    schemaVersion: source.schemaVersion,
    id: source.id,
    name: source.name,
    version: source.version,
    instructions,
    capabilities: source.capabilities,
  });
};

export const createAgentBuild = async (repositoryRoot = locateRepositoryRoot()) => {
  const definition = await loadAgentDefinition(repositoryRoot);
  const registryDocument = await loadFirstPartyCapabilityRegistry();
  const registry = createCapabilityRegistryReader(registryDocument);
  return buildVsCodeAgent(definition, { registry });
};

const normalizeGeneratedPath = (generatedPath) => {
  if (
    typeof generatedPath !== 'string' ||
    generatedPath.length === 0 ||
    path.posix.isAbsolute(generatedPath) ||
    path.win32.isAbsolute(generatedPath) ||
    generatedPath.includes('\\')
  ) {
    throw new Error(`Agent Kit returned an unsafe generated path: ${String(generatedPath)}`);
  }

  const segments = generatedPath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Agent Kit returned an unsafe generated path: ${generatedPath}`);
  }
  return generatedPath;
};

export const collectExpectedOutputs = (build) => {
  const expectedAgentPath = `${GENERATED_AGENT_DIRECTORY}/${build.definition.id}${GENERATED_AGENT_SUFFIX}`;
  const allowedAdapterPaths = new Set([expectedAgentPath, MCP_PATH]);
  const outputs = new Map([[LOCK_PATH, build.lockText]]);

  for (const file of build.adapter.files) {
    const generatedPath = normalizeGeneratedPath(file.path);
    if (!allowedAdapterPaths.has(generatedPath)) {
      throw new Error(`Agent Kit returned an unexpected VS Code adapter path: ${generatedPath}`);
    }
    if (outputs.has(generatedPath)) {
      throw new Error(`Agent Kit returned duplicate generated path: ${generatedPath}`);
    }
    if (typeof file.content !== 'string') {
      throw new Error(`Agent Kit returned non-text content for ${generatedPath}.`);
    }
    outputs.set(generatedPath, file.content);
  }

  for (const requiredPath of allowedAdapterPaths) {
    if (!outputs.has(requiredPath)) {
      throw new Error(`Agent Kit did not return required VS Code adapter path: ${requiredPath}`);
    }
  }

  return outputs;
};

const systemPath = (repositoryRoot, repositoryPath) =>
  path.join(repositoryRoot, ...repositoryPath.split('/'));

const listGeneratedAgentFiles = async (repositoryRoot) => {
  const directory = systemPath(repositoryRoot, GENERATED_AGENT_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter(
      (entry) =>
        entry.name.endsWith(GENERATED_AGENT_SUFFIX) &&
        (entry.isFile() || entry.isSymbolicLink()),
    )
    .map((entry) => `${GENERATED_AGENT_DIRECTORY}/${entry.name}`)
    .sort();
};

const readOutput = async (repositoryRoot, repositoryPath) => {
  try {
    return await readFile(systemPath(repositoryRoot, repositoryPath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

export const checkGeneratedOutputs = async (repositoryRoot, outputs) => {
  const issues = [];
  const expectedAgentPaths = new Set(
    [...outputs.keys()].filter((outputPath) =>
      outputPath.startsWith(`${GENERATED_AGENT_DIRECTORY}/`),
    ),
  );

  for (const generatedPath of await listGeneratedAgentFiles(repositoryRoot)) {
    if (!expectedAgentPaths.has(generatedPath)) {
      issues.push(`obsolete generated agent file: ${generatedPath}`);
    }
  }

  for (const [outputPath, expectedContent] of outputs) {
    const actualContent = await readOutput(repositoryRoot, outputPath);
    if (actualContent === undefined) {
      issues.push(`missing generated file: ${outputPath}`);
    } else if (!actualContent.equals(Buffer.from(expectedContent, 'utf8'))) {
      issues.push(`content differs: ${outputPath}`);
    }
  }

  if (issues.length > 0) {
    throw new GeneratedOutputMismatchError(issues);
  }
};

export const writeGeneratedOutputs = async (repositoryRoot, outputs) => {
  for (const generatedPath of await listGeneratedAgentFiles(repositoryRoot)) {
    await unlink(systemPath(repositoryRoot, generatedPath));
  }

  for (const [outputPath, content] of outputs) {
    const destination = systemPath(repositoryRoot, outputPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, 'utf8');
  }
};

export const buildAgentRepository = async ({
  repositoryRoot = locateRepositoryRoot(),
  check = false,
} = {}) => {
  const root = await realpath(path.resolve(repositoryRoot));
  const build = await createAgentBuild(root);
  const outputs = collectExpectedOutputs(build);

  if (check) {
    await checkGeneratedOutputs(root, outputs);
  } else {
    await writeGeneratedOutputs(root, outputs);
  }

  return { build, outputs };
};

const printSummary = (build, check) => {
  const readinessByCapability = new Map(
    build.readiness.capabilities.map((capability) => [capability.id, capability.state]),
  );
  const action = check ? 'Verified' : 'Built';
  console.log(`${action} ${build.definition.id}@${build.definition.version}.`);
  for (const capability of build.capabilities) {
    console.log(
      `- ${capability.capability.id}@${capability.capability.version.value}: profile ${
        capability.profile.id
      }, binding ${capability.binding.id}, readiness ${
        readinessByCapability.get(capability.capability.id) ?? 'unknown'
      }`,
    );
  }
};

const runCli = async () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== '--check') || arguments_.length > 1) {
    throw new Error('Usage: node scripts/build-agent.mjs [--check]');
  }

  const check = arguments_[0] === '--check';
  const { build } = await buildAgentRepository({ check });
  printSummary(build, check);
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  }
}
