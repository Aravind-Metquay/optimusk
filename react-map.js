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

  let i = 2;
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

function matchesGlob(filePath, pattern) {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(re).test(filePath);
}

// ---------------------------------------------------------------------------
// BUG 7 FIX — Asset import detection
// Skip non-JS imports (CSS, SVG, images, fonts, JSON) before resolution
// ---------------------------------------------------------------------------

const ASSET_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.json', '.html', '.txt', '.md',
]);

function isAssetImport(source) {
  const ext = path.extname(source.split('?')[0]); // strip query strings
  return ASSET_EXTENSIONS.has(ext.toLowerCase());
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
    break;
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

  const tsx = allFiles.find(f => f.endsWith('.tsx'));
  if (tsx) return { entryPoint: tsx, autoDetected: true };
  const ts = allFiles.find(f => f.endsWith('.ts'));
  if (ts) return { entryPoint: ts, autoDetected: true };

  if (allFiles.length > 0) return { entryPoint: allFiles[0], autoDetected: true };
  return { entryPoint: null, autoDetected: true };
}

// ---------------------------------------------------------------------------
// BUG 8 FIX — Import resolution with complete extension + index fallback chain
// ---------------------------------------------------------------------------

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const INDEX_SUFFIXES = [
  '/index.tsx', '/index.ts', '/index.jsx', '/index.js',
];

function resolveImportPath(importSource, currentFile, aliases, baseUrl, projectRoot) {
  // BUG 7 FIX — skip asset imports immediately, don't try to resolve them
  if (isAssetImport(importSource)) return null;

  let resolved = null;
  let resolvedSource = importSource;
  let isAlias = false;

  // BUG 1 & 4 FIX — check aliases FIRST before any path logic
  for (const [alias, target] of Object.entries(aliases)) {
    if (resolvedSource === alias || resolvedSource.startsWith(alias + '/')) {
      const rest = resolvedSource.slice(alias.length);
      resolvedSource = target + rest;
      isAlias = true;
      break;
    }
  }

  let basePath;
  if (isAlias || path.isAbsolute(resolvedSource)) {
    basePath = resolvedSource;
  } else if (resolvedSource.startsWith('./') || resolvedSource.startsWith('../')) {
    basePath = path.resolve(path.dirname(currentFile), resolvedSource);
  } else {
    // Try baseUrl resolution
    basePath = path.resolve(baseUrl, resolvedSource);
    if (!fileExistsSync(basePath) && !RESOLVE_EXTENSIONS.some(ext => fileExistsSync(basePath + ext))) {
      return null; // Library import, not resolvable as project file
    }
  }

  // 1. Direct file match
  if (fileExistsSync(basePath)) {
    const ext = path.extname(basePath);
    if (VALID_EXTENSIONS.has(ext)) return basePath;
  }

  // 2. Try adding extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = basePath + ext;
    if (fileExistsSync(candidate)) return candidate;
  }

  // 3. Try index files
  for (const suffix of INDEX_SUFFIXES) {
    const candidate = basePath + suffix;
    if (fileExistsSync(candidate)) return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// BUG 1 & 4 FIX — isLibraryImport must be alias-aware
// A scoped @alias/path that matches a tsconfig alias is a PROJECT import,
// not an npm scoped package.
// ---------------------------------------------------------------------------

function makeIsLibraryImport(aliases) {
  const aliasKeys = Object.keys(aliases);
  return function isLibraryImport(source) {
    // Relative paths are always project imports
    if (source.startsWith('.') || source.startsWith('/')) return false;
    // Asset imports are neither — handled separately
    if (isAssetImport(source)) return false;
    // Check if source matches any alias prefix
    for (const alias of aliasKeys) {
      if (source === alias || source.startsWith(alias + '/')) return false;
    }
    return true;
  };
}

function getPackageName(source) {
  if (source.startsWith('@')) {
    const parts = source.split('/');
    return parts.slice(0, 2).join('/');
  }
  return source.split('/')[0];
}

// ---------------------------------------------------------------------------
// BUG 2 FIX — Fallback single-file parser for main thread retry
// Extracted as a standalone function so both worker and main thread can use it
// ---------------------------------------------------------------------------

function parseFileSingle(filePath, aliasConfig, projectRoot, babelParser, babelTraverse) {
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

    if (stat.size > 500 * 1024) {
      result.error = 'LARGE_FILE';
      return result;
    }

    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    result.error = `Read error: ${e.message}`;
    return result;
  }

  result.lineCount = content.split('\n').length;

  // Test file detection
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const ext = path.extname(baseName);
  const nameNoExt = baseName.slice(0, -ext.length);
  const testPatterns = [
    `${nameNoExt}.test${ext}`, `${nameNoExt}.spec${ext}`,
    `${nameNoExt}.test.tsx`, `${nameNoExt}.test.ts`,
    `${nameNoExt}.test.js`, `${nameNoExt}.test.jsx`,
    `${nameNoExt}.spec.tsx`, `${nameNoExt}.spec.ts`,
    `${nameNoExt}.spec.js`, `${nameNoExt}.spec.jsx`,
  ];
  for (const tp of testPatterns) {
    try {
      if (fs.statSync(path.join(dir, tp)).isFile()) { result.hasTests = true; break; }
    } catch { /* not found */ }
  }

  if (!content.trim()) return result;

  let ast;
  try {
    ast = babelParser.parse(content, {
      sourceType: 'module',
      plugins: [
        'typescript', 'jsx', 'decorators-legacy', 'classProperties',
        'dynamicImport', 'exportDefaultFrom', 'importMeta',
      ],
      errorRecovery: true,
    });
  } catch (e) {
    result.error = `Parse error: ${e.message}`;
    return result;
  }

  // BUG 1 & 4 FIX — use alias-aware isLibraryImport
  const isLibraryImport = makeIsLibraryImport(aliasConfig.aliases);

  const librarySet = new Set();
  let exportCount = 0;
  let reexportCount = 0;
  let hasRuntimeExport = false;
  let hasDefaultExport = false;
  let defaultExportName = null;

  try {
    babelTraverse(ast, {
      ImportDeclaration(nodePath) {
        const source = nodePath.node.source.value;

        // BUG 7 FIX — skip asset imports silently
        if (isAssetImport(source)) {
          result.imports.project.push({
            source,
            resolvedPath: null,
            unresolved: false,
            type: 'asset',
          });
          return;
        }

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

      CallExpression(nodePath) {
        const node = nodePath.node;

        // Dynamic imports
        if (node.callee.type === 'Import' && node.arguments.length > 0) {
          const arg = node.arguments[0];
          if (arg.type === 'StringLiteral') {
            const source = arg.value;
            // BUG 7 FIX — skip asset dynamic imports
            if (!isAssetImport(source)) {
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
        }

        // useState
        if (node.callee.name === 'useState' || (node.callee.property && node.callee.property.name === 'useState')) {
          const parent = nodePath.parent;
          if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'ArrayPattern') {
            const elements = parent.id.elements;
            if (elements.length > 0 && elements[0]) {
              result.state.push({ name: elements[0].name, type: 'state' });
            }
          }
        }

        // useReducer
        if (node.callee.name === 'useReducer' || (node.callee.property && node.callee.property.name === 'useReducer')) {
          const parent = nodePath.parent;
          if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'ArrayPattern') {
            const elements = parent.id.elements;
            if (elements.length > 0 && elements[0]) {
              result.state.push({ name: elements[0].name, type: 'reducer' });
            }
          }
        }

        // createContext
        if (
          node.callee.name === 'createContext' ||
          (node.callee.type === 'MemberExpression' &&
            node.callee.object && node.callee.object.name === 'React' &&
            node.callee.property && node.callee.property.name === 'createContext')
        ) {
          result.hasCreateContext = true;
        }

        // Store patterns
        if (['createSlice', 'createStore', 'configureStore', 'atom'].includes(node.callee.name)) {
          result.hasStorePatterns = true;
        }
        if (node.callee.name === 'create' && content.includes('zustand')) {
          result.hasStorePatterns = true;
        }

        // navigate()
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

        // createBrowserRouter
        if (node.callee.name === 'createBrowserRouter') {
          result.hasRouterElements = true;
        }
      },

      JSXElement() { result.hasJSX = true; },
      JSXFragment() { result.hasJSX = true; },

      JSXAttribute(nodePath) {
        if (nodePath.node.name && nodePath.node.name.name === 'path') {
          const val = nodePath.node.value;
          if (val && val.type === 'StringLiteral') {
            result.routes.push(val.value);
          }
        }
      },

      JSXOpeningElement(nodePath) {
        const name = nodePath.node.name;
        let elemName = null;
        if (name.type === 'JSXIdentifier') elemName = name.name;
        if (elemName === 'BrowserRouter' || elemName === 'Routes' || elemName === 'Route') {
          result.hasRouterElements = true;
        }
      },

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

        if (node.source) {
          reexportCount++;
          const source = node.source.value;
          const specifiers = node.specifiers.map(s => (s.exported.name || s.exported.value));
          // BUG 7 FIX — skip asset re-exports
          if (isAssetImport(source)) return;
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

      TSInterfaceDeclaration(nodePath) {
        const name = nodePath.node.id.name;
        if (name.endsWith('Props')) {
          for (const member of nodePath.node.body.body) {
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
  result.routes = [...new Set(result.routes)];

  // Barrel: all exports are re-exports and no JSX
  if (exportCount > 0 && reexportCount === exportCount && !result.hasJSX) {
    result.isBarrel = true;
  }

  const hasOnlyTypeExports = result.exports.length > 0 &&
    result.exports.every(e => e.kind === 'type') && !result.hasJSX;

  result._hasRuntimeExport = hasRuntimeExport;
  result._hasDefaultExport = hasDefaultExport;
  result._defaultExportName = defaultExportName;
  result._hasOnlyTypeExports = hasOnlyTypeExports;

  return result;
}

function extractPropsFromParams(params, result, content) {
  if (!params || params.length === 0) return;
  const firstParam = params[0];
  if (firstParam.type === 'ObjectPattern') {
    for (const prop of firstParam.properties) {
      if (prop.type === 'ObjectProperty' && prop.key) {
        const propName = prop.key.name || prop.key.value;
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

// ---------------------------------------------------------------------------
// Worker thread — AST parsing
// ---------------------------------------------------------------------------

if (!isMainThread) {
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

  for (const filePath of files) {
    // BUG 2 FIX — wrap each file parse in try/catch; send error payload, never crash worker
    try {
      const parsed = parseFileSingle(filePath, aliasConfig, projectRoot, babelParser, babelTraverse);
      results.push(parsed);
    } catch (e) {
      // Explicit error payload so main thread can retry
      results.push({
        filePath,
        error: `Worker uncaught: ${e.message}`,
        _workerFailed: true,
        imports: { libraries: [], project: [], dynamic: [], reexports: [] },
        props: [], state: [], routes: [], exports: [],
        externalLibraries: [], type: 'Module',
        lineCount: 0, lastModified: '', hasTests: false,
        hasJSX: false, hasCreateContext: false,
        hasRouterElements: false, hasStorePatterns: false, isBarrel: false,
      });
    }
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

  if (!dirExistsSync(projectRoot)) {
    console.error(`Error: Path "${projectRoot}" does not exist or is not a directory.`);
    process.exit(1);
  }

  await ensureDependencies(projectRoot);

  // Load babel here on main thread for fallback re-parsing (BUG 2 FIX)
  let babelParser, babelTraverse;
  try {
    babelParser = require('@babel/parser');
    babelTraverse = require('@babel/traverse');
    if (babelTraverse.default) babelTraverse = babelTraverse.default;
  } catch (e) {
    console.error('Could not load babel dependencies:', e.message);
    process.exit(1);
  }

  const pkgJsonPath = path.join(projectRoot, 'package.json');
  const pkgContent = tryReadFileSync(pkgJsonPath);
  let pkgJson = {};
  if (pkgContent) {
    try { pkgJson = JSON.parse(pkgContent); } catch { /* ignore */ }
  }
  const projectName = pkgJson.name || path.basename(projectRoot);
  const projectVersion = pkgJson.version || '0.0.0';

  // BUG 1 FIX — load aliases on main thread FIRST, before anything else
  const aliasConfig = readAliases(projectRoot);
  const aliasesForOutput = {};
  for (const [k, v] of Object.entries(aliasConfig.aliases)) {
    aliasesForOutput[k] = normalizePath(path.relative(projectRoot, v));
  }
  console.log(`Aliases loaded: ${JSON.stringify(aliasesForOutput)}`);

  const excludeDirs = new Set(DEFAULT_EXCLUDE_DIRS);
  const ignoreEntries = readIgnoreFile(projectRoot);
  for (const entry of ignoreEntries) excludeDirs.add(entry);
  const extraExcludePatterns = [...args.excludePatterns];

  const isMonorepo = dirExistsSync(path.join(projectRoot, 'packages'));

  console.log(`Scanning project at: ${projectRoot}`);
  const allFiles = walkDir(projectRoot, excludeDirs, extraExcludePatterns);
  console.log(`Found ${allFiles.length} source files.`);

  if (allFiles.length === 0) {
    console.log('No source files found. Writing empty roadmap.');
    writeOutput(buildEmptyResult(projectName, projectVersion, aliasesForOutput), args);
    return;
  }

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

  // Compute hashes
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
          filePath: f, error: 'LARGE_FILE',
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
      continue;
    }
    const hash = md5(content);
    fileHashes[f] = hash;

    // BUG 10 FIX — cache key is file hash only at this stage;
    // dependency-aware invalidation happens after all files are parsed
    if (!args.noCache && cache[f] === hash && cachedMetadata[f]) {
      cachedResults[f] = cachedMetadata[f];
    } else {
      filesToParse.push(f);
    }
  }

  console.log(`Files to parse: ${filesToParse.length} (${Object.keys(cachedResults).length} cached)`);

  // Parse files using worker threads
  let freshParsed = {};

  if (filesToParse.length > 0) {
    const numWorkers = Math.max(1, Math.min(os.cpus().length - 1, filesToParse.length));
    const batchSize = Math.ceil(filesToParse.length / numWorkers);
    const batches = [];
    for (let i = 0; i < filesToParse.length; i += batchSize) {
      batches.push(filesToParse.slice(i, i + batchSize));
    }

    console.log(`Spawning ${batches.length} worker(s)...`);

    // BUG 3 FIX — Promise.all ensures all workers complete before tree building
    const workerPromises = batches.map(batch => {
      return new Promise((resolve) => {
        const worker = new Worker(__filename, {
          workerData: { files: batch, projectRoot, aliasConfig },
        });
        const workerResults = [];
        worker.on('message', msg => {
          if (msg.results) workerResults.push(...msg.results);
        });
        // BUG 2 FIX — on worker crash, resolve with empty so we can retry below
        worker.on('error', err => {
          console.warn(`Worker error: ${err.message}. Affected files will be re-parsed on main thread.`);
          resolve({ results: batch.map(fp => ({ filePath: fp, error: `Worker crash: ${err.message}`, _workerFailed: true })) });
        });
        worker.on('exit', code => {
          if (code !== 0 && workerResults.length === 0) {
            resolve({ results: batch.map(fp => ({ filePath: fp, error: `Worker exited ${code}`, _workerFailed: true })) });
          } else {
            resolve({ results: workerResults });
          }
        });
      });
    });

    const workerOutputs = await Promise.all(workerPromises);

    // BUG 2 FIX — collect worker results; flag failed ones for main-thread retry
    const failedFiles = [];
    for (const output of workerOutputs) {
      for (const r of output.results) {
        if (r._workerFailed) {
          failedFiles.push(r.filePath);
        } else {
          freshParsed[r.filePath] = r;
        }
      }
    }

    // BUG 2 FIX — retry failed files synchronously on main thread
    if (failedFiles.length > 0) {
      console.log(`Retrying ${failedFiles.length} failed file(s) on main thread...`);
      for (const fp of failedFiles) {
        try {
          const retried = parseFileSingle(fp, aliasConfig, projectRoot, babelParser, babelTraverse);
          if (retried.error) {
            console.warn(`  Re-parse failed for ${path.basename(fp)}: ${retried.error}`);
          } else {
            console.log(`  Re-parse succeeded for ${path.basename(fp)}`);
          }
          freshParsed[fp] = retried;
        } catch (e) {
          console.warn(`  Re-parse threw for ${path.basename(fp)}: ${e.message}`);
          freshParsed[fp] = {
            filePath: fp, error: `Main thread retry failed: ${e.message}`,
            imports: { libraries: [], project: [], dynamic: [], reexports: [] },
            props: [], state: [], routes: [], exports: [],
            externalLibraries: [], type: 'Module',
            lineCount: 0, lastModified: '', hasTests: false,
            hasJSX: false, hasCreateContext: false,
            hasRouterElements: false, hasStorePatterns: false, isBarrel: false,
          };
        }
      }
    }
  }

  // Merge cached and fresh results
  const allResults = { ...cachedResults, ...freshParsed };

  // BUG 3 FIX — assert all files are accounted for before building tree
  const missingFromMap = [];
  for (const f of allFiles) {
    if (!allResults[f] && !largeFiles.includes(normalizePath(relativeTo(projectRoot, f)))) {
      missingFromMap.push(f);
    }
  }
  if (missingFromMap.length > 0) {
    console.warn(`Warning: ${missingFromMap.length} file(s) missing from metadata map after parse. Parsing now...`);
    for (const fp of missingFromMap) {
      allResults[fp] = parseFileSingle(fp, aliasConfig, projectRoot, babelParser, babelTraverse);
    }
  }

  // BUG 10 FIX — dependency-aware cache invalidation
  // After all files are parsed, check if any cached file's imports have changed
  // (even if the file content itself didn't change)
  const depsChangedFiles = [];
  for (const [fp, data] of Object.entries(cachedResults)) {
    if (!data || data.error) continue;
    const allProjectImports = [
      ...data.imports.project,
      ...data.imports.dynamic,
      ...data.imports.reexports,
    ];
    let depsChanged = false;
    for (const imp of allProjectImports) {
      if (imp.resolvedPath && !fileExistsSync(imp.resolvedPath)) {
        depsChanged = true;
        break;
      }
    }
    if (depsChanged) depsChangedFiles.push(fp);
  }
  if (depsChangedFiles.length > 0) {
    console.log(`Re-parsing ${depsChangedFiles.length} file(s) with stale dependency paths...`);
    for (const fp of depsChangedFiles) {
      allResults[fp] = parseFileSingle(fp, aliasConfig, projectRoot, babelParser, babelTraverse);
    }
  }

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

  // Classify all files
  const parseErrors = [];
  const unresolvedImports = [];

  for (const [fp, data] of Object.entries(allResults)) {
    if (data.error && data.error !== 'LARGE_FILE') {
      parseErrors.push({ file: normalizePath(relativeTo(projectRoot, fp)), error: data.error });
    }
    data.type = classifyFile(fp, data, projectRoot);

    // Collect unresolved imports
    const allImports = [
      ...data.imports.project,
      ...data.imports.dynamic,
      ...data.imports.reexports,
    ];
    for (const imp of allImports) {
      if (imp.unresolved && imp.type !== 'asset') {
        unresolvedImports.push({
          file: normalizePath(relativeTo(projectRoot, fp)),
          import: imp.source,
        });
      }
    }
  }

  // Build dependency tree
  const allFileSet = new Set(allFiles.map(f => normalizePath(f)));
  const allImportedFiles = new Set();
  const circularDependencies = [];
  const visited = new Set();

  function buildTree(filePath, depth = 0) {
    const normalizedPath = normalizePath(filePath);
    const relPath = relativeTo(projectRoot, filePath);
    const data = allResults[filePath];

    if (!data) {
      return {
        name: path.basename(filePath),
        path: '/' + normalizePath(relPath),
        relativePath: normalizePath(relPath),
        type: 'Module', lineCount: 0, lastModified: '', hasTests: false,
        imports: { libraries: [], project: [], dynamic: [], reexports: [] },
        props: [], state: [], routes: [], exports: [],
        externalLibraries: [], circular: false, children: [],
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
        libraries: data.imports.libraries.map(l => typeof l === 'string' ? l : l.source),
        project: data.imports.project
          .filter(p => p.type !== 'asset')
          .map(p => ({
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

    if (isCircular) return node;

    visited.add(normalizedPath);

    // BUG 9 FIX — traverse reexports as children, same as project imports
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
          externalLibraries: [], circular: true, children: [],
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

  // BUG 5 FIX — Post-build integrity validation (iterative, not recursive)
  // Uses an explicit stack + visited Set to:
  //   1. Avoid stack overflow on deep trees (was: recursive validateTree)
  //   2. Avoid infinite loops when re-parsed nodes add new children
  //      that are themselves empty stubs (was: validateTree called on new children)
  const suspectNodes = [];
  const parseErrorFiles = new Set(parseErrors.map(e => e.file));

  function validateTree(rootNode) {
    // visited tracks relativePaths we have already inspected so we never
    // process the same node twice, even if it appears in multiple subtrees
    // or is newly added as a child during re-parse.
    const validateVisited = new Set();
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();

      // Guard: skip if already validated or if this is a circular stub
      if (!node || validateVisited.has(node.relativePath) || node.circular) continue;
      validateVisited.add(node.relativePath);

      // Check if this node looks suspiciously empty
      const looksEmpty =
        node.lineCount === 0 &&
        node.imports.libraries.length === 0 &&
        node.imports.project.length === 0 &&
        node.children.length === 0;

      if (looksEmpty) {
        const absPath = path.join(projectRoot, node.relativePath);
        if (fileExistsSync(absPath)) {
          const content = tryReadFileSync(absPath);
          if (content && content.trim().length > 0) {
            suspectNodes.push({
              file: node.relativePath,
              reason: 'parsed as empty but file has content',
              lineCount: content.split('\n').length,
            });

            // Attempt re-parse and patch node in-place
            try {
              const reparse = parseFileSingle(absPath, aliasConfig, projectRoot, babelParser, babelTraverse);
              if (!reparse.error) {
                reparse.type = classifyFile(absPath, reparse, projectRoot);
                allResults[absPath] = reparse;

                // Patch all scalar fields on the node in-place
                node.lineCount = reparse.lineCount;
                node.lastModified = reparse.lastModified;
                node.type = reparse.type;
                node.imports.libraries = reparse.imports.libraries.map(l => typeof l === 'string' ? l : l.source);
                node.imports.project = reparse.imports.project
                  .filter(p => p.type !== 'asset')
                  .map(p => ({
                    source: p.source,
                    resolved: p.resolvedPath ? normalizePath(relativeTo(projectRoot, p.resolvedPath)) : null,
                    unresolved: p.unresolved || false,
                  }));
                node.props = reparse.props;
                node.state = reparse.state;
                node.routes = reparse.routes;
                node.exports = reparse.exports;
                node.externalLibraries = reparse.externalLibraries;

                // Re-build children only for paths not yet in the visited set
                // to prevent adding nodes that will immediately be re-validated
                const newChildPaths = [
                  ...reparse.imports.project,
                  ...reparse.imports.dynamic,
                  ...reparse.imports.reexports,
                ].filter(imp => imp.resolvedPath).map(imp => imp.resolvedPath);

                for (const childPath of newChildPaths) {
                  const normalizedChild = normalizePath(childPath);
                  allImportedFiles.add(normalizedChild);
                  // Only add child if:
                  //  - it's a known project file
                  //  - not already in buildTree's visited set (prevents re-traversal)
                  //  - not already validated (prevents re-validation loop)
                  if (
                    allFileSet.has(normalizedChild) &&
                    !visited.has(normalizedChild) &&
                    !validateVisited.has(normalizePath(relativeTo(projectRoot, childPath)))
                  ) {
                    const childNode = buildTree(childPath);
                    node.children.push(childNode);
                    // Push newly added children onto the stack so they get validated too,
                    // but only once — the validateVisited Set prevents re-entry.
                    stack.push(childNode);
                  }
                }

                console.log(`  Suspect node re-parsed: ${node.relativePath} (${node.lineCount} lines, ${node.children.length} children)`);
              }
            } catch (e) {
              console.warn(`  Suspect node re-parse threw for ${node.relativePath}: ${e.message}`);
            }
          }
        }
      }

      // Push existing children onto the stack for validation.
      // We push them AFTER processing the current node so newly added
      // children (from re-parse above) and pre-existing ones are handled
      // uniformly — the validateVisited Set ensures no node is ever
      // processed twice regardless of how it ended up in the stack.
      for (const child of node.children) {
        if (!validateVisited.has(child.relativePath)) {
          stack.push(child);
        }
      }
    }
  }

  if (tree) {
    console.log('Running post-build integrity validation...');
    validateTree(tree);
    if (suspectNodes.length > 0) {
      console.warn(`Found ${suspectNodes.length} suspect node(s) (empty parse despite having content).`);
    }
  }

  // BUG 6 FIX — Orphan detection accounts for failed parses
  // A file is only "truly orphaned" if its potential parents are not themselves broken
  const orphanedFiles = [];
  const entryNormalized = entryPoint ? normalizePath(entryPoint) : null;

  for (const f of allFiles) {
    const nf = normalizePath(f);
    if (nf === entryNormalized) continue;
    if (allImportedFiles.has(nf)) continue;

    const relF = normalizePath(relativeTo(projectRoot, f));
    const data = allResults[f];
    const isInErrorFile = parseErrorFiles.has(relF);
    const isSuspect = suspectNodes.some(s => s.file === relF);

    // If this file has failed imports pointing to it from files in parseErrors,
    // mark as unresolved rather than orphaned
    if (isInErrorFile || isSuspect) {
      orphanedFiles.push({ path: relF, orphanStatus: 'unresolved' });
    } else {
      orphanedFiles.push({ path: relF, orphanStatus: 'orphaned' });
    }
  }

  // For backward compatibility, keep orphanedFiles as array of strings
  // but add a separate detailed breakdown
  const orphanedFilePaths = orphanedFiles.map(o => o.path);
  const orphanedDetails = orphanedFiles;

  // Stats
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
    if (!circSet.has(key)) { circSet.add(key); circDedup.push(cd); }
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
    orphanedFiles: orphanedFilePaths,
    orphanedDetails,
    unresolvedImports,
    suspectNodes,
    aliases: aliasesForOutput,
    tree: tree || {},
  };

  if (largeFiles.length > 0) output.largeFiles = largeFiles;

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
          let pkgName = entry.name, pkgVersion = '0.0.0';
          if (pkgPkgJson) {
            try {
              const parsed = JSON.parse(pkgPkgJson);
              pkgName = parsed.name || entry.name;
              pkgVersion = parsed.version || '0.0.0';
            } catch { /* ignore */ }
          }
          packages.push({ name: pkgName, version: pkgVersion, path: normalizePath(relativeTo(projectRoot, pkgPath)) });
        }
      }
      if (packages.length > 0) output.packages = packages;
    } catch { /* ignore */ }
  }

  // Verification report
  console.log('\n--- Verification ---');
  console.log(`Metadata map entries:  ${Object.keys(allResults).length} / ${allFiles.length} files`);
  const zeroLineNodes = countZeroLineNodes(tree);
  console.log(`Zero-line nodes in tree: ${zeroLineNodes}`);
  console.log(`Suspect nodes:         ${suspectNodes.length}`);
  console.log(`Parse errors:          ${parseErrors.length}`);
  console.log(`Unresolved imports:    ${unresolvedImports.length}`);
  console.log(`Orphaned files:        ${orphanedFilePaths.length}`);
  if (orphanedFilePaths.length > 0 && orphanedFilePaths.length <= 5) {
    for (const o of orphanedDetails.slice(0, 5)) {
      console.log(`  [${o.orphanStatus}] ${o.path}`);
    }
  }
  // BUG 5 FIX — explicit check for App.tsx still empty
  const appNode = findNodeByName(tree, 'App.tsx');
  if (appNode && appNode.lineCount === 0) {
    console.error('\nERROR: App.tsx is still an empty node after all fixes.');
    console.error('Check parseErrors for App.tsx:');
    const appError = parseErrors.find(e => e.file.endsWith('App.tsx'));
    if (appError) {
      console.error(`  ${appError.error}`);
    } else {
      console.error('  No parse error recorded — possible metadata map miss.');
    }
  }

  writeOutput(output, args);
  if (args.summary) printSummary(output);
}

function countZeroLineNodes(root) {
  if (!root) return 0;
  let count = 0;
  const stack = [root];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || seen.has(node.relativePath)) continue;
    seen.add(node.relativePath);
    if (node.lineCount === 0) count++;
    for (const child of (node.children || [])) stack.push(child);
  }
  return count;
}

function findNodeByName(root, name) {
  if (!root) return null;
  const stack = [root];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || seen.has(node.relativePath)) continue;
    seen.add(node.relativePath);
    if (node.name === name) return node;
    for (const child of (node.children || [])) stack.push(child);
  }
  return null;
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function classifyFile(filePath, data, projectRoot) {
  const basename = path.basename(filePath);
  const nameNoExt = basename.replace(/\.(tsx?|jsx?)$/, '');
  const relPath = normalizePath(path.relative(projectRoot, filePath));
  const parts = relPath.split('/');
  const folderNames = parts.slice(0, -1);

  if (data.isBarrel) return 'Barrel';
  if (data._hasOnlyTypeExports) return 'TypeDefinition';

  if (nameNoExt.startsWith('use') && nameNoExt.length > 3 &&
      nameNoExt[3] === nameNoExt[3].toUpperCase()) {
    return 'Hook';
  }

  if (basename.includes('Context') || basename.includes('Provider') || data.hasCreateContext) {
    return 'Context';
  }

  if (folderNames.some(f => f === 'pages' || f === 'views' || f === 'screens') ||
      nameNoExt.endsWith('Page') || nameNoExt.endsWith('View')) {
    return 'Page';
  }

  if (folderNames.some(f => f === 'layouts') || nameNoExt.includes('Layout')) {
    return 'Layout';
  }

  if (data.hasRouterElements) return 'Router';
  if (data.hasStorePatterns) return 'Store';

  if (folderNames.some(f => f === 'utils' || f === 'helpers' || f === 'lib') && !data.hasJSX) {
    return 'Utility';
  }

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
  const json = args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
  fs.writeFileSync(outputPath, json, 'utf-8');
  console.log(`\nOutput written to: ${outputPath}`);
}

function buildEmptyResult(projectName, version, aliases) {
  return {
    projectName, version,
    scannedAt: new Date().toISOString(),
    entryPoint: null, entryPointAutoDetected: true,
    totalFiles: 0, totalComponents: 0, totalHooks: 0, totalPages: 0,
    parseErrors: [], circularDependencies: [],
    orphanedFiles: [], orphanedDetails: [],
    unresolvedImports: [], suspectNodes: [],
    aliases, tree: {},
  };
}

function printSummary(output) {
  console.log('\n' + '='.repeat(50));
  console.log('  PROJECT ROADMAP SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Project:            ${output.projectName}`);
  console.log(`  Version:            ${output.version}`);
  console.log(`  Entry Point:        ${output.entryPoint || 'N/A'}`);
  console.log(`  Auto-detected:      ${output.entryPointAutoDetected}`);
  console.log('-'.repeat(50));
  console.log(`  Total Files:        ${output.totalFiles}`);
  console.log(`  Components:         ${output.totalComponents}`);
  console.log(`  Hooks:              ${output.totalHooks}`);
  console.log(`  Pages:              ${output.totalPages}`);
  console.log(`  Orphaned Files:     ${output.orphanedFiles.length}`);
  console.log(`  Parse Errors:       ${output.parseErrors.length}`);
  console.log(`  Circular Deps:      ${output.circularDependencies.length}`);
  console.log(`  Unresolved Imports: ${output.unresolvedImports.length}`);
  console.log(`  Suspect Nodes:      ${output.suspectNodes.length}`);
  if (output.largeFiles && output.largeFiles.length > 0) {
    console.log(`  Large Files:        ${output.largeFiles.length}`);
  }
  if (output.packages) {
    console.log(`  Packages:           ${output.packages.length}`);
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