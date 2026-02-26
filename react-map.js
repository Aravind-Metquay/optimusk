#!/usr/bin/env node

/**
 * react-map.js — Production-grade React project architecture crawler.
 * Analyzes React/TypeScript projects and outputs a project-roadmap.json.
 *
 * Usage: node react-map.js <project-path> [flags]
 *
 * Flags:
 *   --no-cache          Ignore existing cache
 *   --exclude <glob>    Additional glob patterns to exclude (repeatable)
 *   --output <path>     Custom output path for JSON
 *   --entry <path>      Manual entry point
 *   --pretty            Pretty-print JSON
 *   --summary           Print summary table after writing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    projectPath: null,
    noCache: false,
    excludePatterns: [],
    outputPath: null,
    entryOverride: null,
    pretty: false,
    summary: false,
  };

  let i = 2; // skip node and script path
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--no-cache') {
      args.noCache = true;
    } else if (arg === '--exclude') {
      i++;
      if (i < argv.length) args.excludePatterns.push(argv[i]);
    } else if (arg === '--output') {
      i++;
      if (i < argv.length) args.outputPath = argv[i];
    } else if (arg === '--entry') {
      i++;
      if (i < argv.length) args.entryOverride = argv[i];
    } else if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg === '--summary') {
      args.summary = true;
    } else if (!arg.startsWith('--') && args.projectPath === null) {
      args.projectPath = arg;
    }
    i++;
  }

  if (!args.projectPath) args.projectPath = process.cwd();
  args.projectPath = path.resolve(args.projectPath);
  return args;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function relativeTo(base, abs) {
  return normalizePath(path.relative(base, abs));
}

function md5(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

function tryReadFileSync(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function fileExistsSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExistsSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function getFileStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// Simple glob-style matching for exclude patterns
function matchesGlob(filePath, pattern) {
  // Convert glob to regex
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(re).test(filePath);
}

// ---------------------------------------------------------------------------
// File discovery — recursive walk
// ---------------------------------------------------------------------------

const VALID_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '.next', '.nuxt', 'coverage', '.nyc_output',
]);

function shouldExcludeFile(basename) {
  if (basename.endsWith('.d.ts')) return true;
  // *.test.*, *.spec.*, *.stories.*
  const parts = basename.split('.');
  if (parts.length >= 3) {
    const mid = parts.slice(1, -1);
    for (const m of mid) {
      if (m === 'test' || m === 'spec' || m === 'stories') return true;
    }
  }
  return false;
}

function walkDir(dir, excludeDirs, extraExcludePatterns) {
  const results = [];

  function recurse(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        // Check extra exclude patterns against relative path
        let skip = false;
        for (const pat of extraExcludePatterns) {
          if (matchesGlob(normalizePath(fullPath), pat) || matchesGlob(entry.name, pat)) {
            skip = true;
            break;
          }
        }
        if (!skip) recurse(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!VALID_EXTENSIONS.has(ext)) continue;
        if (shouldExcludeFile(entry.name)) continue;
        let skip = false;
        for (const pat of extraExcludePatterns) {
          if (matchesGlob(normalizePath(fullPath), pat) || matchesGlob(entry.name, pat)) {
            skip = true;
            break;
          }
        }
        if (!skip) results.push(fullPath);
      }
    }
  }

  recurse(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Read .react-map-ignore
// ---------------------------------------------------------------------------

function readIgnoreFile(projectRoot) {
  const ignPath = path.join(projectRoot, '.react-map-ignore');
  const content = tryReadFileSync(ignPath);
  if (!content) return [];
  return content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

// ---------------------------------------------------------------------------
// Alias resolution from tsconfig / jsconfig
// ---------------------------------------------------------------------------

function readAliases(projectRoot) {
  const aliases = {};
  let baseUrl = '.';
  for (const cfg of ['tsconfig.json', 'jsconfig.json']) {
    const cfgPath = path.join(projectRoot, cfg);
    const content = tryReadFileSync(cfgPath);
    if (!content) continue;
    try {
      // Strip comments (single-line)
      const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const json = JSON.parse(stripped);
      if (json.compilerOptions) {
        if (json.compilerOptions.baseUrl) baseUrl = json.compilerOptions.baseUrl;
        if (json.compilerOptions.paths) {
          for (const [alias, targets] of Object.entries(json.compilerOptions.paths)) {
            const cleanAlias = alias.replace(/\/\*$/, '');
            const target = (targets[0] || '').replace(/\/\*$/, '');
            aliases[cleanAlias] = path.resolve(projectRoot, baseUrl, target);
          }
        }
      }
    } catch {
      // Ignore malformed config
    }
    break; // Use first found
  }
  return { aliases, baseUrl: path.resolve(projectRoot, baseUrl) };
}

// ---------------------------------------------------------------------------
// Entry point detection
// ---------------------------------------------------------------------------

const ENTRY_CANDIDATES = [
  'src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts',
  'src/index.js', 'index.js', 'index.tsx',
];

function detectEntryPoint(projectRoot, allFiles, entryOverride) {
  if (entryOverride) {
    const abs = path.resolve(projectRoot, entryOverride);
    if (fileExistsSync(abs)) return { entryPoint: abs, autoDetected: false };
  }

  for (const candidate of ENTRY_CANDIDATES) {
    const abs = path.join(projectRoot, candidate);
    if (fileExistsSync(abs)) return { entryPoint: abs, autoDetected: false };
  }

  // Fallback: first .tsx or .ts file
  const tsx = allFiles.find(f => f.endsWith('.tsx'));
  if (tsx) return { entryPoint: tsx, autoDetected: true };
  const ts = allFiles.find(f => f.endsWith('.ts'));
  if (ts) return { entryPoint: ts, autoDetected: true };

  if (allFiles.length > 0) return { entryPoint: allFiles[0], autoDetected: true };
  return { entryPoint: null, autoDetected: true };
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const INDEX_FILES = ['/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

function resolveImportPath(importSource, currentFile, aliases, baseUrl, projectRoot) {
  let resolved = null;
  let isAlias = false;

  // Check if it's an alias
  for (const [alias, target] of Object.entries(aliases)) {
    if (importSource === alias || importSource.startsWith(alias + '/')) {
      const rest = importSource.slice(alias.length);
      importSource = target + rest;
      isAlias = true;
      break;
    }
  }

  let basePath;
  if (isAlias || path.isAbsolute(importSource)) {
    basePath = importSource;
  } else if (importSource.startsWith('./') || importSource.startsWith('../')) {
    basePath = path.resolve(path.dirname(currentFile), importSource);
  } else {
    // Try baseUrl resolution
    basePath = path.resolve(baseUrl, importSource);
    if (!fileExistsSync(basePath) && !RESOLVE_EXTENSIONS.some(ext => fileExistsSync(basePath + ext))) {
      return null; // Library import
    }
  }

  // Direct file match
  if (fileExistsSync(basePath)) {
    const ext = path.extname(basePath);
    if (VALID_EXTENSIONS.has(ext)) return basePath;
  }

  // Try extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    if (fileExistsSync(basePath + ext)) return basePath + ext;
  }

  // Try index files
  for (const idx of INDEX_FILES) {
    if (fileExistsSync(basePath + idx)) return basePath + idx;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Worker thread — AST parsing
// ---------------------------------------------------------------------------

if (!isMainThread) {
  // Worker: receives file paths, returns parsed metadata
  let babelParser, babelTraverse;
  try {
    babelParser = require('@babel/parser');
    babelTraverse = require('@babel/traverse');
    if (babelTraverse.default) babelTraverse = babelTraverse.default;
  } catch (e) {
    parentPort.postMessage({ error: 'Missing babel dependencies: ' + e.message, results: [] });
    process.exit(1);
  }

  const { files, projectRoot, aliasConfig } = workerData;
  const results = [];

  const PARSER_PLUGINS = [
    'typescript', 'jsx', 'decorators-legacy', 'classProperties',
    'dynamicImport', 'exportDefaultFrom', 'importMeta',
  ];

  function parseFile(filePath) {
    const result = {
      filePath,
      error: null,
      imports: { libraries: [], project: [], dynamic: [], reexports: [] },
      props: [],
      state: [],
      routes: [],
      exports: [],
      externalLibraries: [],
      type: 'Module',
      lineCount: 0,
      lastModified: '',
      hasTests: false,
      hasJSX: false,
      hasCreateContext: false,
      hasRouterElements: false,
      hasStorePatterns: false,
      isBarrel: false,
    };

    let content;
    try {
      const stat = fs.statSync(filePath);
      result.lastModified = stat.mtime.toISOString();

      // Skip large files (> 500KB)
      if (stat.size > 500 * 1024) {
        result.error = 'LARGE_FILE';
        result.lineCount = 0;
        return result;
      }

      content = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      result.error = `Read error: ${e.message}`;
      return result;
    }

    result.lineCount = content.split('\n').length;

    // Check for test file existence
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const ext = path.extname(baseName);
    const nameNoExt = baseName.slice(0, -ext.length);
    const testPatterns = [
      `${nameNoExt}.test${ext}`,
      `${nameNoExt}.spec${ext}`,
      `${nameNoExt}.test.tsx`,
      `${nameNoExt}.test.ts`,
      `${nameNoExt}.test.js`,
      `${nameNoExt}.test.jsx`,
      `${nameNoExt}.spec.tsx`,
      `${nameNoExt}.spec.ts`,
      `${nameNoExt}.spec.js`,
      `${nameNoExt}.spec.jsx`,
    ];
    for (const tp of testPatterns) {
      try {
        if (fs.statSync(path.join(dir, tp)).isFile()) {
          result.hasTests = true;
          break;
        }
      } catch { /* not found */ }
    }

    if (!content.trim()) {
      return result; // Empty file
    }

    // Parse AST
    let ast;
    try {
      const isTS = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
      ast = babelParser.parse(content, {
        sourceType: 'module',
        plugins: PARSER_PLUGINS,
        errorRecovery: true,
      });
    } catch (e) {
      result.error = `Parse error: ${e.message}`;
      return result;
    }

    const librarySet = new Set();
    let exportCount = 0;
    let reexportCount = 0;
    let hasRuntimeExport = false;
    let hasDefaultExport = false;
    let defaultExportName = null;

    try {
      babelTraverse(ast, {
        // --- Import declarations ---
        ImportDeclaration(nodePath) {
          const source = nodePath.node.source.value;
          const specifiers = nodePath.node.specifiers.map(s => {
            if (s.type === 'ImportDefaultSpecifier') return s.local.name;
            if (s.type === 'ImportNamespaceSpecifier') return `* as ${s.local.name}`;
            return s.imported ? (s.imported.name || s.imported.value) : s.local.name;
          });

          if (isLibraryImport(source)) {
            const pkgName = getPackageName(source);
            librarySet.add(pkgName);
            result.imports.libraries.push({ source: pkgName, specifiers });
          } else {
            const resolved = resolveImportPath(
              source, filePath, aliasConfig.aliases, aliasConfig.baseUrl, projectRoot
            );
            result.imports.project.push({
              source,
              resolvedPath: resolved ? normalizePath(resolved) : null,
              unresolved: !resolved,
              specifiers,
            });
          }
        },

        // --- Dynamic imports ---
        CallExpression(nodePath) {
          const node = nodePath.node;

          // import('./...')
          if (node.callee.type === 'Import' && node.arguments.length > 0) {
            const arg = node.arguments[0];
            if (arg.type === 'StringLiteral') {
              const source = arg.value;
              if (isLibraryImport(source)) {
                librarySet.add(getPackageName(source));
              } else {
                const resolved = resolveImportPath(
                  source, filePath, aliasConfig.aliases, aliasConfig.baseUrl, projectRoot
                );
                result.imports.dynamic.push({
                  source,
                  resolvedPath: resolved ? normalizePath(resolved) : null,
                  unresolved: !resolved,
                  isDynamic: true,
                });
              }
            }
          }

          // useState detection
          if (node.callee.name === 'useState' || (node.callee.property && node.callee.property.name === 'useState')) {
            const parent = nodePath.parent;
            if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'ArrayPattern') {
              const elements = parent.id.elements;
              if (elements.length > 0 && elements[0]) {
                result.state.push({ name: elements[0].name, type: 'state' });
              }
            }
          }

          // useReducer detection
          if (node.callee.name === 'useReducer' || (node.callee.property && node.callee.property.name === 'useReducer')) {
            const parent = nodePath.parent;
            if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'ArrayPattern') {
              const elements = parent.id.elements;
              if (elements.length > 0 && elements[0]) {
                result.state.push({ name: elements[0].name, type: 'reducer' });
              }
            }
          }

          // createContext detection
          if (
            node.callee.name === 'createContext' ||
            (node.callee.type === 'MemberExpression' &&
              node.callee.object && node.callee.object.name === 'React' &&
              node.callee.property && node.callee.property.name === 'createContext')
          ) {
            result.hasCreateContext = true;
          }

          // Store pattern detection
          if (node.callee.name === 'createSlice' || node.callee.name === 'createStore' ||
              node.callee.name === 'configureStore') {
            result.hasStorePatterns = true;
          }
          if (node.callee.name === 'atom') {
            result.hasStorePatterns = true;
          }
          if (node.callee.name === 'create' && content.includes('zustand')) {
            result.hasStorePatterns = true;
          }

          // navigate() detection for routes
          if (node.callee.name === 'navigate' || (node.callee.property && node.callee.property.name === 'navigate')) {
            if (node.arguments.length > 0 && node.arguments[0].type === 'StringLiteral') {
              result.routes.push(node.arguments[0].value);
            }
          }
          if (node.callee.property && node.callee.property.name === 'push') {
            if (node.arguments.length > 0 && node.arguments[0].type === 'StringLiteral') {
              const val = node.arguments[0].value;
              if (val.startsWith('/')) result.routes.push(val);
            }
          }

          // createBrowserRouter detection
          if (node.callee.name === 'createBrowserRouter') {
            result.hasRouterElements = true;
          }
        },

        // --- JSX detection ---
        JSXElement() {
          result.hasJSX = true;
        },
        JSXFragment() {
          result.hasJSX = true;
        },

        // --- JSX Route path detection ---
        JSXAttribute(nodePath) {
          if (nodePath.node.name && nodePath.node.name.name === 'path') {
            const val = nodePath.node.value;
            if (val && val.type === 'StringLiteral') {
              result.routes.push(val.value);
            }
          }
        },

        // --- JSX opening elements for router detection ---
        JSXOpeningElement(nodePath) {
          const name = nodePath.node.name;
          let elemName = null;
          if (name.type === 'JSXIdentifier') elemName = name.name;

          if (elemName === 'BrowserRouter' || elemName === 'Routes' || elemName === 'Route') {
            result.hasRouterElements = true;
          }
        },

        // --- Export declarations ---
        ExportDefaultDeclaration(nodePath) {
          hasDefaultExport = true;
          exportCount++;
          hasRuntimeExport = true;
          const decl = nodePath.node.declaration;
          let name = 'default';
          let kind = 'unknown';
          if (decl.type === 'FunctionDeclaration' || decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') {
            kind = 'function';
            if (decl.id) name = decl.id.name;
          } else if (decl.type === 'ClassDeclaration') {
            kind = 'class';
            if (decl.id) name = decl.id.name;
          } else if (decl.type === 'Identifier') {
            name = decl.name;
            kind = 'constant';
          }
          defaultExportName = name;
          result.exports.push({ name, kind, isDefault: true });
        },

        ExportNamedDeclaration(nodePath) {
          const node = nodePath.node;
          exportCount++;

          // Re-export: export { X } from './Y'
          if (node.source) {
            reexportCount++;
            const source = node.source.value;
            const specifiers = node.specifiers.map(s => (s.exported.name || s.exported.value));
            if (isLibraryImport(source)) {
              librarySet.add(getPackageName(source));
            } else {
              const resolved = resolveImportPath(
                source, filePath, aliasConfig.aliases, aliasConfig.baseUrl, projectRoot
              );
              result.imports.reexports.push({
                source,
                resolvedPath: resolved ? normalizePath(resolved) : null,
                unresolved: !resolved,
                specifiers,
                type: 'reexport',
              });
            }
            return;
          }

          if (node.declaration) {
            hasRuntimeExport = true;
            const decl = node.declaration;
            if (decl.type === 'FunctionDeclaration') {
              result.exports.push({ name: decl.id ? decl.id.name : 'anonymous', kind: 'function', isDefault: false });
            } else if (decl.type === 'ClassDeclaration') {
              result.exports.push({ name: decl.id ? decl.id.name : 'anonymous', kind: 'class', isDefault: false });
            } else if (decl.type === 'VariableDeclaration') {
              for (const d of decl.declarations) {
                if (d.id && d.id.name) {
                  result.exports.push({ name: d.id.name, kind: 'constant', isDefault: false });
                }
              }
            } else if (decl.type === 'TSTypeAliasDeclaration' || decl.type === 'TSInterfaceDeclaration') {
              result.exports.push({ name: decl.id ? decl.id.name : 'anonymous', kind: 'type', isDefault: false });
            } else if (decl.type === 'TSEnumDeclaration') {
              hasRuntimeExport = true;
              result.exports.push({ name: decl.id ? decl.id.name : 'anonymous', kind: 'constant', isDefault: false });
            }
          } else if (node.specifiers) {
            hasRuntimeExport = true;
            for (const spec of node.specifiers) {
              result.exports.push({
                name: spec.exported.name || spec.exported.value,
                kind: 'constant',
                isDefault: false,
              });
            }
          }
        },

        // --- Props detection from TS interfaces/types ---
        TSInterfaceDeclaration(nodePath) {
          const name = nodePath.node.id.name;
          if (name.endsWith('Props')) {
            const members = nodePath.node.body.body;
            for (const member of members) {
              if (member.type === 'TSPropertySignature' && member.key) {
                const propName = member.key.name || member.key.value;
                let propType = 'unknown';
                if (member.typeAnnotation && member.typeAnnotation.typeAnnotation) {
                  propType = content.slice(
                    member.typeAnnotation.typeAnnotation.start,
                    member.typeAnnotation.typeAnnotation.end
                  );
                }
                result.props.push({ name: propName, type: propType });
              }
            }
          }
        },

        TSTypeAliasDeclaration(nodePath) {
          const name = nodePath.node.id.name;
          if (name.endsWith('Props') && nodePath.node.typeAnnotation) {
            const typeAnno = nodePath.node.typeAnnotation;
            if (typeAnno.type === 'TSTypeLiteral') {
              for (const member of typeAnno.members) {
                if (member.type === 'TSPropertySignature' && member.key) {
                  const propName = member.key.name || member.key.value;
                  let propType = 'unknown';
                  if (member.typeAnnotation && member.typeAnnotation.typeAnnotation) {
                    propType = content.slice(
                      member.typeAnnotation.typeAnnotation.start,
                      member.typeAnnotation.typeAnnotation.end
                    );
                  }
                  result.props.push({ name: propName, type: propType });
                }
              }
            }
          }
        },

        // --- Props from function parameter destructuring ---
        FunctionDeclaration(nodePath) {
          extractPropsFromParams(nodePath.node.params, result, content);
        },
        ArrowFunctionExpression(nodePath) {
          extractPropsFromParams(nodePath.node.params, result, content);
        },
      });
    } catch (e) {
      result.error = `Traversal error: ${e.message}`;
      return result;
    }

    result.externalLibraries = Array.from(librarySet);

    // Deduplicate routes
    result.routes = [...new Set(result.routes)];

    // Detect barrel files
    if (exportCount > 0 && reexportCount === exportCount && !result.hasJSX) {
      result.isBarrel = true;
    }

    // Check if only type exports
    const hasOnlyTypeExports = result.exports.length > 0 &&
      result.exports.every(e => e.kind === 'type') && !result.hasJSX;

    // Store for classification
    result._hasRuntimeExport = hasRuntimeExport;
    result._hasDefaultExport = hasDefaultExport;
    result._defaultExportName = defaultExportName;
    result._hasOnlyTypeExports = hasOnlyTypeExports;

    return result;
  }

  function isLibraryImport(source) {
    if (source.startsWith('.') || source.startsWith('/')) return false;
    // Alias check handled at resolution time
    return true;
  }

  function getPackageName(source) {
    if (source.startsWith('@')) {
      const parts = source.split('/');
      return parts.slice(0, 2).join('/');
    }
    return source.split('/')[0];
  }

  function extractPropsFromParams(params, result, content) {
    if (!params || params.length === 0) return;
    const firstParam = params[0];
    if (firstParam.type === 'ObjectPattern') {
      // Check if it has a type annotation ending in Props
      let isPropsParam = false;
      if (firstParam.typeAnnotation && firstParam.typeAnnotation.typeAnnotation) {
        const ta = firstParam.typeAnnotation.typeAnnotation;
        if (ta.type === 'TSTypeReference' && ta.typeName) {
          const name = ta.typeName.name || '';
          if (name.endsWith('Props')) isPropsParam = true;
        }
      }
      // Even without explicit Props type annotation, capture destructured params
      // for component functions (we'll rely on classification later)
      if (isPropsParam || true) {
        for (const prop of firstParam.properties) {
          if (prop.type === 'ObjectProperty' && prop.key) {
            const propName = prop.key.name || prop.key.value;
            // Avoid duplicates
            if (propName && !result.props.find(p => p.name === propName)) {
              result.props.push({ name: propName, type: 'unknown' });
            }
          } else if (prop.type === 'RestElement' && prop.argument) {
            const propName = prop.argument.name;
            if (propName && !result.props.find(p => p.name === propName)) {
              result.props.push({ name: propName, type: 'rest' });
            }
          }
        }
      }
    }
  }

  // Process all files
  for (const filePath of files) {
    results.push(parseFile(filePath));
  }

  parentPort.postMessage({ results });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main thread logic
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const projectRoot = args.projectPath;

  // Validate project path
  if (!dirExistsSync(projectRoot)) {
    console.error(`Error: Path "${projectRoot}" does not exist or is not a directory.`);
    process.exit(1);
  }

  // Ensure dependencies
  await ensureDependencies(projectRoot);

  // Read package.json
  const pkgJsonPath = path.join(projectRoot, 'package.json');
  const pkgContent = tryReadFileSync(pkgJsonPath);
  let pkgJson = {};
  if (pkgContent) {
    try { pkgJson = JSON.parse(pkgContent); } catch { /* ignore */ }
  }
  const projectName = pkgJson.name || path.basename(projectRoot);
  const projectVersion = pkgJson.version || '0.0.0';

  // Read aliases
  const aliasConfig = readAliases(projectRoot);
  const aliasesForOutput = {};
  for (const [k, v] of Object.entries(aliasConfig.aliases)) {
    aliasesForOutput[k] = normalizePath(path.relative(projectRoot, v));
  }

  // Determine exclusions
  const excludeDirs = new Set(DEFAULT_EXCLUDE_DIRS);
  const ignoreEntries = readIgnoreFile(projectRoot);
  for (const entry of ignoreEntries) {
    excludeDirs.add(entry);
  }
  const extraExcludePatterns = [...args.excludePatterns];

  // Check for monorepo
  const isMonorepo = dirExistsSync(path.join(projectRoot, 'packages'));

  // Discover files
  console.log(`Scanning project at: ${projectRoot}`);
  const allFiles = walkDir(projectRoot, excludeDirs, extraExcludePatterns);
  console.log(`Found ${allFiles.length} source files.`);

  if (allFiles.length === 0) {
    console.log('No source files found. Writing empty roadmap.');
    const emptyResult = buildEmptyResult(projectName, projectVersion, aliasesForOutput);
    writeOutput(emptyResult, args);
    return;
  }

  // Entry point
  const { entryPoint, autoDetected } = detectEntryPoint(projectRoot, allFiles, args.entryOverride);

  // Cache handling
  const cacheFilePath = path.join(projectRoot, '.react-map-cache.json');
  let cache = {};
  let cachedMetadata = {};
  if (!args.noCache) {
    const cacheContent = tryReadFileSync(cacheFilePath);
    if (cacheContent) {
      try {
        const parsed = JSON.parse(cacheContent);
        cache = parsed.hashes || {};
        cachedMetadata = parsed.metadata || {};
      } catch { /* ignore corrupt cache */ }
    }
  }

  // Compute hashes and determine which files need reparsing
  const fileHashes = {};
  const filesToParse = [];
  const cachedResults = {};
  const largeFiles = [];

  for (const f of allFiles) {
    let content;
    try {
      const stat = fs.statSync(f);
      if (stat.size > 500 * 1024) {
        largeFiles.push(normalizePath(relativeTo(projectRoot, f)));
        fileHashes[f] = 'LARGE';
        cachedResults[f] = {
          filePath: f,
          error: 'LARGE_FILE',
          imports: { libraries: [], project: [], dynamic: [], reexports: [] },
          props: [], state: [], routes: [], exports: [],
          externalLibraries: [], type: 'Module',
          lineCount: 0, lastModified: stat.mtime.toISOString(),
          hasTests: false, hasJSX: false, hasCreateContext: false,
          hasRouterElements: false, hasStorePatterns: false, isBarrel: false,
        };
        continue;
      }
      content = fs.readFileSync(f, 'utf-8');
    } catch {
      // Binary or unreadable — skip
      continue;
    }
    const hash = md5(content);
    fileHashes[f] = hash;

    if (!args.noCache && cache[f] === hash && cachedMetadata[f]) {
      cachedResults[f] = cachedMetadata[f];
    } else {
      filesToParse.push(f);
    }
  }

  console.log(`Files to parse: ${filesToParse.length} (${Object.keys(cachedResults).length} cached)`);

  // Parse files using worker threads
  let parsedResults = {};

  if (filesToParse.length > 0) {
    const numWorkers = Math.max(1, Math.min(os.cpus().length - 1, filesToParse.length));
    const batchSize = Math.ceil(filesToParse.length / numWorkers);
    const batches = [];
    for (let i = 0; i < filesToParse.length; i += batchSize) {
      batches.push(filesToParse.slice(i, i + batchSize));
    }

    console.log(`Spawning ${batches.length} worker(s)...`);

    const workerPromises = batches.map(batch => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
          workerData: {
            files: batch,
            projectRoot,
            aliasConfig,
          },
        });
        worker.on('message', msg => resolve(msg));
        worker.on('error', err => reject(err));
        worker.on('exit', code => {
          if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
      });
    });

    const workerResults = await Promise.all(workerPromises);
    for (const wr of workerResults) {
      if (wr.error) {
        console.warn(`Worker error: ${wr.error}`);
        continue;
      }
      for (const r of wr.results) {
        parsedResults[r.filePath] = r;
      }
    }
  }

  // Merge cached and fresh results
  const allResults = { ...cachedResults, ...parsedResults };

  // Update cache
  const newCache = { hashes: fileHashes, metadata: {} };
  for (const [fp, data] of Object.entries(allResults)) {
    newCache.metadata[fp] = data;
  }
  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(newCache));
  } catch {
    console.warn('Warning: Could not write cache file.');
  }

  // Classify files
  const allFileSet = new Set(allFiles.map(f => normalizePath(f)));
  const parseErrors = [];

  for (const [fp, data] of Object.entries(allResults)) {
    if (data.error && data.error !== 'LARGE_FILE') {
      parseErrors.push({ file: normalizePath(relativeTo(projectRoot, fp)), error: data.error });
    }
    data.type = classifyFile(fp, data, projectRoot);
  }

  // Build dependency tree
  const visited = new Set();
  const allImportedFiles = new Set();
  const circularDependencies = [];

  function buildTree(filePath, depth = 0) {
    const normalizedPath = normalizePath(filePath);
    const relPath = relativeTo(projectRoot, filePath);
    const data = allResults[filePath];

    if (!data) {
      return {
        name: path.basename(filePath),
        path: '/' + normalizePath(relPath),
        relativePath: normalizePath(relPath),
        type: 'Module',
        lineCount: 0,
        lastModified: '',
        hasTests: false,
        imports: { libraries: [], project: [], dynamic: [], reexports: [] },
        props: [], state: [], routes: [], exports: [],
        externalLibraries: [],
        circular: false,
        children: [],
      };
    }

    const isCircular = visited.has(normalizedPath);
    const node = {
      name: path.basename(filePath),
      path: '/' + normalizePath(relPath),
      relativePath: normalizePath(relPath),
      type: filePath === entryPoint ? 'Root' : data.type,
      lineCount: data.lineCount,
      lastModified: data.lastModified,
      hasTests: data.hasTests,
      imports: {
        libraries: data.imports.libraries.map(l => l.source),
        project: data.imports.project.map(p => ({
          source: p.source,
          resolved: p.resolvedPath ? normalizePath(relativeTo(projectRoot, p.resolvedPath)) : null,
          unresolved: p.unresolved || false,
        })),
        dynamic: data.imports.dynamic.map(d => ({
          source: d.source,
          resolved: d.resolvedPath ? normalizePath(relativeTo(projectRoot, d.resolvedPath)) : null,
          isDynamic: true,
          unresolved: d.unresolved || false,
        })),
        reexports: data.imports.reexports.map(r => ({
          source: r.source,
          resolved: r.resolvedPath ? normalizePath(relativeTo(projectRoot, r.resolvedPath)) : null,
          specifiers: r.specifiers,
          unresolved: r.unresolved || false,
        })),
      },
      props: data.props,
      state: data.state,
      routes: data.routes,
      exports: data.exports,
      externalLibraries: data.externalLibraries,
      circular: isCircular,
      children: [],
    };

    if (isCircular) {
      return node;
    }

    visited.add(normalizedPath);

    // Collect all children from project imports, dynamic imports, and reexports
    const childPaths = [];

    for (const imp of data.imports.project) {
      if (imp.resolvedPath) {
        allImportedFiles.add(normalizePath(imp.resolvedPath));
        childPaths.push(imp.resolvedPath);
      }
    }
    for (const imp of data.imports.dynamic) {
      if (imp.resolvedPath) {
        allImportedFiles.add(normalizePath(imp.resolvedPath));
        childPaths.push(imp.resolvedPath);
      }
    }
    for (const imp of data.imports.reexports) {
      if (imp.resolvedPath) {
        allImportedFiles.add(normalizePath(imp.resolvedPath));
        childPaths.push(imp.resolvedPath);
      }
    }

    for (const childPath of childPaths) {
      const normalizedChild = normalizePath(childPath);
      if (visited.has(normalizedChild)) {
        circularDependencies.push({
          from: normalizePath(relPath),
          to: normalizePath(relativeTo(projectRoot, childPath)),
        });
        // Add a circular stub
        const childData = allResults[childPath];
        node.children.push({
          name: path.basename(childPath),
          path: '/' + normalizePath(relativeTo(projectRoot, childPath)),
          relativePath: normalizePath(relativeTo(projectRoot, childPath)),
          type: childData ? childData.type : 'Module',
          lineCount: childData ? childData.lineCount : 0,
          lastModified: childData ? childData.lastModified : '',
          hasTests: childData ? childData.hasTests : false,
          imports: { libraries: [], project: [], dynamic: [], reexports: [] },
          props: [], state: [], routes: [], exports: [],
          externalLibraries: [],
          circular: true,
          children: [],
        });
      } else if (allFileSet.has(normalizedChild)) {
        node.children.push(buildTree(childPath, depth + 1));
      }
    }

    return node;
  }

  let tree = null;
  if (entryPoint) {
    tree = buildTree(entryPoint);
  }

  // Orphaned files
  const orphanedFiles = [];
  const entryNormalized = entryPoint ? normalizePath(entryPoint) : null;
  for (const f of allFiles) {
    const nf = normalizePath(f);
    if (nf !== entryNormalized && !allImportedFiles.has(nf)) {
      orphanedFiles.push(normalizePath(relativeTo(projectRoot, f)));
    }
  }

  // Count stats
  let totalComponents = 0, totalHooks = 0, totalPages = 0;
  for (const data of Object.values(allResults)) {
    if (data.type === 'Component') totalComponents++;
    if (data.type === 'Hook') totalHooks++;
    if (data.type === 'Page') totalPages++;
  }

  // Deduplicate circular dependencies
  const circDedup = [];
  const circSet = new Set();
  for (const cd of circularDependencies) {
    const key = `${cd.from}|${cd.to}`;
    if (!circSet.has(key)) {
      circSet.add(key);
      circDedup.push(cd);
    }
  }

  // Build final output
  const output = {
    projectName,
    version: projectVersion,
    scannedAt: new Date().toISOString(),
    entryPoint: entryPoint ? normalizePath(relativeTo(projectRoot, entryPoint)) : null,
    entryPointAutoDetected: autoDetected,
    totalFiles: allFiles.length,
    totalComponents,
    totalHooks,
    totalPages,
    parseErrors,
    circularDependencies: circDedup,
    orphanedFiles,
    aliases: aliasesForOutput,
    tree: tree || {},
  };

  if (largeFiles.length > 0) {
    output.largeFiles = largeFiles;
  }

  // Monorepo support
  if (isMonorepo) {
    const packagesDir = path.join(projectRoot, 'packages');
    try {
      const pkgEntries = fs.readdirSync(packagesDir, { withFileTypes: true });
      const packages = [];
      for (const entry of pkgEntries) {
        if (entry.isDirectory()) {
          const pkgPath = path.join(packagesDir, entry.name);
          const pkgPkgJson = tryReadFileSync(path.join(pkgPath, 'package.json'));
          let pkgName = entry.name;
          let pkgVersion = '0.0.0';
          if (pkgPkgJson) {
            try {
              const parsed = JSON.parse(pkgPkgJson);
              pkgName = parsed.name || entry.name;
              pkgVersion = parsed.version || '0.0.0';
            } catch { /* ignore */ }
          }
          packages.push({
            name: pkgName,
            version: pkgVersion,
            path: normalizePath(relativeTo(projectRoot, pkgPath)),
          });
        }
      }
      if (packages.length > 0) {
        output.packages = packages;
      }
    } catch { /* ignore read errors */ }
  }

  writeOutput(output, args);

  if (args.summary) {
    printSummary(output);
  }
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function classifyFile(filePath, data, projectRoot) {
  const basename = path.basename(filePath);
  const nameNoExt = basename.replace(/\.(tsx?|jsx?)$/, '');
  const relPath = normalizePath(path.relative(projectRoot, filePath));
  const parts = relPath.split('/');

  // 1. Barrel file detection
  if (data.isBarrel) return 'Barrel';

  // 2. Type definition only
  if (data._hasOnlyTypeExports) return 'TypeDefinition';

  // 3. Hook
  if (nameNoExt.startsWith('use') && nameNoExt.length > 3 && nameNoExt[3] === nameNoExt[3].toUpperCase()) {
    return 'Hook';
  }

  // 4. Context
  if (basename.includes('Context') || basename.includes('Provider') || data.hasCreateContext) {
    return 'Context';
  }

  // 5. Page
  const folderNames = parts.slice(0, -1);
  if (folderNames.some(f => f === 'pages' || f === 'views' || f === 'screens') ||
      nameNoExt.endsWith('Page') || nameNoExt.endsWith('View')) {
    return 'Page';
  }

  // 6. Layout
  if (folderNames.some(f => f === 'layouts') || nameNoExt.includes('Layout')) {
    return 'Layout';
  }

  // 7. Router
  if (data.hasRouterElements) return 'Router';

  // 8. Store
  if (data.hasStorePatterns) return 'Store';

  // 9. Utility
  if (folderNames.some(f => f === 'utils' || f === 'helpers' || f === 'lib') && !data.hasJSX) {
    return 'Utility';
  }

  // 10. Component (has JSX or exports capitalized function)
  if (data.hasJSX) return 'Component';
  if (data._hasDefaultExport && data._defaultExportName &&
      data._defaultExportName[0] === data._defaultExportName[0].toUpperCase() &&
      data._defaultExportName[0] !== data._defaultExportName[0].toLowerCase()) {
    return 'Component';
  }

  return 'Module';
}

// ---------------------------------------------------------------------------
// Ensure dependencies
// ---------------------------------------------------------------------------

async function ensureDependencies(projectRoot) {
  const requiredPackages = ['@babel/parser', '@babel/traverse'];
  const missing = [];

  for (const pkg of requiredPackages) {
    try {
      require.resolve(pkg, { paths: [projectRoot, __dirname, process.cwd()] });
    } catch {
      missing.push(pkg);
    }
  }

  if (missing.length > 0) {
    console.log(`Installing missing dependencies: ${missing.join(', ')}...`);
    const { execSync } = require('child_process');
    try {
      execSync(`npm install --no-save ${missing.join(' ')}`, {
        cwd: __dirname,
        stdio: 'inherit',
      });
    } catch (e) {
      console.error(`Failed to install dependencies: ${e.message}`);
      console.error('Please manually run: npm install @babel/parser @babel/traverse');
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Output writing
// ---------------------------------------------------------------------------

function writeOutput(output, args) {
  const outputPath = args.outputPath || path.join(process.cwd(), 'project-roadmap.json');
  const json = args.pretty
    ? JSON.stringify(output, null, 2)
    : JSON.stringify(output);

  fs.writeFileSync(outputPath, json, 'utf-8');
  console.log(`\nOutput written to: ${outputPath}`);
}

function buildEmptyResult(projectName, version, aliases) {
  return {
    projectName,
    version,
    scannedAt: new Date().toISOString(),
    entryPoint: null,
    entryPointAutoDetected: true,
    totalFiles: 0,
    totalComponents: 0,
    totalHooks: 0,
    totalPages: 0,
    parseErrors: [],
    circularDependencies: [],
    orphanedFiles: [],
    aliases,
    tree: {},
  };
}

function printSummary(output) {
  console.log('\n' + '='.repeat(50));
  console.log('  PROJECT ROADMAP SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Project:          ${output.projectName}`);
  console.log(`  Version:          ${output.version}`);
  console.log(`  Entry Point:      ${output.entryPoint || 'N/A'}`);
  console.log(`  Auto-detected:    ${output.entryPointAutoDetected}`);
  console.log('-'.repeat(50));
  console.log(`  Total Files:      ${output.totalFiles}`);
  console.log(`  Components:       ${output.totalComponents}`);
  console.log(`  Hooks:            ${output.totalHooks}`);
  console.log(`  Pages:            ${output.totalPages}`);
  console.log(`  Orphaned Files:   ${output.orphanedFiles.length}`);
  console.log(`  Parse Errors:     ${output.parseErrors.length}`);
  console.log(`  Circular Deps:    ${output.circularDependencies.length}`);
  if (output.largeFiles && output.largeFiles.length > 0) {
    console.log(`  Large Files:      ${output.largeFiles.length}`);
  }
  if (output.packages) {
    console.log(`  Packages:         ${output.packages.length}`);
  }
  console.log('='.repeat(50));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (isMainThread) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
