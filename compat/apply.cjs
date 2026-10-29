const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { dirname, join, resolve } = require('node:path');
const definitions = require('./patches.json');

function resolveFrom(directory) {
  const localRequire = createRequire(join(resolve(directory), 'package.json'));
  try {
    return dirname(localRequire.resolve(`${definitions.package.name}/package.json`));
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

/** Resolve once: an unsupported consumer dependency must never select a fallback. */
function resolveNitroDirectory({
  cwd = process.cwd(),
  nitroPath,
  helperDirectory = __dirname,
} = {}) {
  if (nitroPath !== undefined) return resolve(cwd, nitroPath);
  const consumer = resolveFrom(cwd);
  if (consumer !== undefined) return consumer;
  const installed = resolveFrom(helperDirectory);
  if (installed !== undefined) return installed;
  throw new Error(
    'Cannot locate react-native-nitro-modules from the current project or this helper. ' +
      'Install the dependency or pass --nitro-path PATH to its package directory.',
  );
}

function skipQuoted(source, start) {
  const quote = source[start];
  for (let position = start + 1; position < source.length; position += 1) {
    if (source[position] === '\\') position += 1;
    else if (source[position] === quote) return position + 1;
  }
  throw new Error('Unterminated string or character literal in target method');
}

function skipLineComment(source, start) {
  let end = source.indexOf('\n', start + 2);
  // C++ joins backslash-newline before recognizing comments.
  while (end >= 0 && source[end - 1] === '\\') end = source.indexOf('\n', end + 1);
  return end < 0 ? source.length : end;
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  if (end < 0) throw new Error('Unterminated comment in target source');
  return end + 2;
}

function skipRawString(source, start) {
  const opening = source.indexOf('(', start + 2);
  const delimiter = source.slice(start + 2, opening);
  if (opening < 0 || delimiter.length > 16 || /[\s()\\]/.test(delimiter))
    throw new Error('Unexpected raw string delimiter in target source');
  const closing = ')' + delimiter + '"';
  const end = source.indexOf(closing, opening + 1);
  if (end < 0) throw new Error('Unterminated raw string in target source');
  return end + closing.length;
}

/** Only select real, line-anchored declarations, never saved examples or literals. */
function activeSignatures(source, signature) {
  const positions = [];
  let conditionalDepth = 0;
  for (let position = 0; position < source.length; position += 1) {
    const character = source[position];
    const next = source[position + 1];
    if (character === '#') {
      const lineStart = source.lastIndexOf('\n', position - 1) + 1;
      if (source.slice(lineStart, position).trim() === '') {
        const directive = source.slice(position).match(/^#[ \t]*(if|ifdef|ifndef|endif)\b/);
        if (directive) {
          conditionalDepth += directive[1] === 'endif' ? -1 : 1;
          if (conditionalDepth < 0)
            throw new Error('Unbalanced conditional directives in target source');
        }
      }
    } else if (character === '/' && next === '/') position = skipLineComment(source, position) - 1;
    else if (character === '/' && next === '*') position = skipBlockComment(source, position) - 1;
    else if (character === 'R' && next === '"') position = skipRawString(source, position) - 1;
    else if (character === '"' || character === "'") position = skipQuoted(source, position) - 1;
    else if (
      /[0-9]/.test(character) &&
      (position === 0 || !/[A-Za-z_0-9]/.test(source[position - 1]))
    ) {
      // C++ digit separators are not character-literal quotes.
      while (position + 1 < source.length && /[A-Za-z_0-9'.]/.test(source[position + 1]))
        position += 1;
    } else if (
      conditionalDepth === 0 &&
      (position === 0 || source[position - 1] === '\n') &&
      source.startsWith(signature, position)
    )
      positions.push(position);
  }
  if (conditionalDepth !== 0) throw new Error('Unbalanced conditional directives in target source');
  return positions;
}

/** Find the complete method without mistaking braces inside comments or strings. */
function methodRange(source, signature) {
  const positions = activeSignatures(source, signature);
  if (positions.length !== 1) {
    throw new Error(`Expected exactly one known method signature: ${signature.trim()}`);
  }
  const [start] = positions;
  let depth = 0;
  for (let position = start + signature.length - 1; position < source.length; position += 1) {
    const character = source[position];
    const next = source[position + 1];
    if (character === '"' || character === "'") {
      position = skipQuoted(source, position) - 1;
    } else if (character === '/' && next === '/') {
      position = skipLineComment(source, position) - 1;
    } else if (character === '/' && next === '*') {
      position = skipBlockComment(source, position) - 1;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: position + 1 };
    }
  }
  throw new Error(`Cannot find complete target method: ${signature.trim()}`);
}

// Upstream/app backports differ only by standalone // comments. Keep literal
// source matching for all code lines, including strings and control flow.
function withoutCommentLines(source) {
  return source
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '' && (!line.trimStart().startsWith('//') || line.trimEnd().endsWith('\\')),
    )
    .join('\n');
}

function inspectTarget(target, before) {
  const hasCRLF = before.includes('\r\n');
  if (hasCRLF && before.replaceAll('\r\n', '').includes('\n')) {
    throw new Error(`Mixed line endings in ${target.path}; refusing to change unrelated bytes`);
  }
  const source = before.replaceAll('\r\n', '\n');
  // Phase-2 splicing can form comment delimiters before C++ tokenization.
  // Known 0.37.1 headers contain no continuations; reject ambiguous custom
  // sources, including Clang's whitespace-after-backslash extension.
  if (/\\[ \t\v\f]*\n/.test(source))
    throw new Error(`Unsupported C++ line continuation in ${target.path}. No files were changed.`);
  const { start, end } = methodRange(source, target.signature);
  const method = withoutCommentLines(source.slice(start, end));
  const original = withoutCommentLines(target.original);
  const patched = withoutCommentLines(target.patched);
  let status;
  if (method === original) status = 'needs-patch';
  else if (method === patched) status = 'fixed';
  else {
    throw new Error(
      `Unexpected source in ${target.path}; the known Nitro 0.37.1 method has changed. ` +
        'No files were changed. Review your existing dependency patches before applying this backport.',
    );
  }
  let after = before;
  if (status === 'needs-patch') {
    const changed = source.slice(0, start) + target.patched + source.slice(end);
    after = hasCRLF ? changed.replaceAll('\n', '\r\n') : changed;
  }
  return { after, status };
}

/** Combine independent guarded hunks before staging one replacement per file. */
function inspectFiles(directory, io) {
  const groups = new Map();
  for (const target of definitions.targets) {
    if (!groups.has(target.path)) groups.set(target.path, []);
    groups.get(target.path).push(target);
  }
  return [...groups].map(([relativePath, targets]) => {
    const path = join(directory, relativePath);
    const before = io.readFileSync(path, 'utf8');
    let after = before;
    for (const target of targets) after = inspectTarget(target, after).after;
    return {
      path,
      relativePath,
      before,
      after,
      status: before === after ? 'fixed' : 'needs-patch',
    };
  });
}

function stageReplacement(file, source, staged, io) {
  const path = join(dirname(file.path), `.nitro-xxhash-compat-${process.pid}-${randomUUID()}.tmp`);
  const mode = io.statSync(file.path).mode & 0o7777;
  const descriptor = io.openSync(path, 'wx', mode);
  // Register only a file we created, never a path whose exclusive open failed.
  staged.push(path);
  try {
    io.writeFileSync(descriptor, source, 'utf8');
    io.fchmodSync(descriptor, mode);
  } finally {
    io.closeSync(descriptor);
  }
  return path;
}

function restoreFiles(attempted, staged, io) {
  const failures = [];
  for (const file of attempted.toReversed()) {
    try {
      const current = io.readFileSync(file.path, 'utf8');
      if (current === file.before) continue;
      const identity = io.statSync(file.path, { bigint: true });
      if (
        current !== file.after ||
        identity.dev !== file.identity.dev ||
        identity.ino !== file.identity.ino
      )
        throw new Error('Changed by another process after replacement; refusing to overwrite it');
      const replacement = stageReplacement(file, file.before, staged, io);
      io.renameSync(replacement, file.path);
    } catch (error) {
      failures.push(`${file.relativePath}: ${error.message}`);
    }
  }
  return failures;
}

function cleanStagedFiles(staged, io) {
  const failures = [];
  for (const path of staged) {
    try {
      io.unlinkSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push(`${path}: ${error.message}`);
    }
  }
  return failures;
}

/** Explicit CLI or prebuild operation only; importing never mutates dependencies. */
function runCompatibility(options = {}) {
  const io = options.io || fs;
  const directory = resolveNitroDirectory(options);
  const manifest = JSON.parse(io.readFileSync(join(directory, 'package.json'), 'utf8'));
  if (
    manifest.name !== definitions.package.name ||
    manifest.version !== definitions.package.version
  ) {
    throw new Error(
      `Expected ${definitions.package.name}@${definitions.package.version}; ` +
        `found ${String(manifest.name)}@${String(manifest.version)} in ${directory}. ` +
        'No files were changed. Select the intended dependency with --nitro-path PATH.',
    );
  }
  // Read and validate all complete source targets before attempting any write.
  const files = inspectFiles(directory, io);
  const changes = files.filter((file) => file.status === 'needs-patch');
  const result = {
    directory,
    version: manifest.version,
    status: changes.length === 0 ? 'already-fixed' : 'needs-patch',
    files: files.map((file) => ({ path: file.relativePath, status: file.status })),
  };
  if (options.check || changes.length === 0) return result;

  const attempted = [];
  const staged = [];
  try {
    // Stage all complete replacements before replacing any target. Renaming
    // same-directory files is atomic and breaks pnpm/store hardlinks safely.
    const replacements = changes.map((file) => ({
      file,
      replacement: stageReplacement(file, file.after, staged, io),
    }));
    for (const { file, replacement } of replacements) {
      if (io.readFileSync(file.path, 'utf8') !== file.before) {
        throw new Error(`${file.relativePath} changed after validation; refusing to overwrite it`);
      }
      const identity = io.statSync(replacement, { bigint: true });
      io.renameSync(replacement, file.path);
      attempted.push({ ...file, identity });
    }
  } catch (error) {
    const failures = restoreFiles(attempted, staged, io);
    const leftovers = cleanStagedFiles(staged, io);
    const recovery =
      failures.length === 0
        ? 'All attempted changes were rolled back.'
        : `Rollback could not restore: ${failures.join('; ')}. Restore these dependency files before rebuilding.`;
    const cleanup =
      leftovers.length === 0 ? '' : ` Staged files need cleanup: ${leftovers.join('; ')}.`;
    throw new Error(
      `Cannot apply the Nitro compatibility repairs: ${error.message}. ${recovery}${cleanup} ` +
        "For read-only or PnP installations, use your package manager's patched-dependency workflow " +
        `with the definitions in ${join(__dirname, 'patches.json')}.`,
      { cause: error },
    );
  }
  const leftovers = cleanStagedFiles(staged, io);
  if (leftovers.length > 0) {
    throw new Error(
      `The Nitro compatibility repairs were applied, but staged files need cleanup: ${leftovers.join('; ')}`,
    );
  }
  return {
    ...result,
    status: 'applied',
    files: result.files.map((file) => ({ ...file, status: 'fixed' })),
  };
}

module.exports = { runCompatibility, resolveNitroDirectory };
