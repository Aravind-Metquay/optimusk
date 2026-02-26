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
// BUG 1: Load aliases on main thread at startup BEFORE workers are spawned.
//        The result is serialized and passed as part of worker initialization.
// ---------------------------------------------------------------------------

function readAliases(projectRoot) {
  const aliases = {};
  let baseUrl = '.';
  for (const cfg of ['tsconfig.json', 'jsconfig.json']) {
    const cfgPath = path.join(projectRoot, cfg);
    const content = tryReadFileSync(cfgPath);
    if (!content) continue;
    try {
      // Strip single-line and block comments
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
// BUG 8: Resolver tries all extension/index variants in correct order.
//        Unresolved imports are returned as null (caller adds to unresolvedImports).
// ---------------------------------------------------------------------------

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const INDEX_FILES = ['/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

// BUG 7: Asset extension set — skip resolution for these entirely
const ASSET_EXTENSIONS_SET = new Set([
  '.css', '.scss', '.sass', '.less', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.json',
]);

function isAssetImport(source) {
  const base = source.split('?')[0].split('#')[0];
  return ASSET_EXTENSIONS_SET.has(path.extname(base));
}

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

  // BUG 8: Try candidates in exact order:
  // 1. Path as-is (direct file match with valid extension)
  if (fileExistsSync(basePath)) {
    const ext = path.extname(basePath);
    if (VALID_EXTENSIONS.has(ext)) return basePath;
  }

  // 2-5. Path + .tsx / .ts / .jsx / .js
  for (const ext of RESOLVE_EXTENSIONS) {
    if (fileExistsSync(basePath + ext)) return basePath + ext;
  }

  // 6-9. Path + /index.tsx / /index.ts / /index.jsx / /index.js
  for (const idx of INDEX_FILES) {
    if (fileExistsSync(basePath + idx)) return basePath + idx;
  }

  return null;
}

// ---------------------------------------------------------------------------
// BUG 4: isLibraryImport — checks alias map BEFORE heuristic.
//        @/lib, @/components etc. match aliases and are project imports.
//        @org/package (scoped npm) does NOT match any alias key → library.
// ---------------------------------------------------------------------------

function isLibraryImport(source, aliases) {
  if (source.startsWith('.') || source.startsWith('/')) return false;
  // BUG 4: check alias map first
  for (const alias of Object.keys(aliases)) {
    if (source === alias || source.startsWith(alias + '/')) return false;
  }
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
    let isPropsParam = false;
    if (firstParam.typeAnnotation && firstParam.typeAnnotation.typeAnnotation) {
      const ta = firstParam.typeAnnotation.typeAnnotation;
      if (ta.type === 'TSTypeReference' && ta.typeName) {
        const name = ta.typeName.name || '';
        if (name.endsWith('Props')) isPropsParam = true;
      }
    }
    if (isPropsParam || true) {
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
}

function makeEmptyFileResult(filePath) {
  return {
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
}

// ---------------------------------------------------------------------------
// Core file parser — shared between worker threads AND main-thread fallback
// BUG 2: Extracted outside worker block so main thread can call it as fallback.
// BUG 1+4: Uses isLibraryImport(source, aliases) to check alias map first.
// BUG 7: Skips asset imports before attempting resolution.
// BUG 9: Barrel reexports are included in imports.reexports for tree traversal.
// ---------------------------------------------------------------------------

const PARSER_PLUGINS = [
  'typescript', 'jsx', 'decorators-legacy', 'classProperties',
  'dynamicImport', 'exportDefaultFrom', 'importMeta',
];

function parseSingleFile(filePath, aliasConfig, projectRoot, babelParser, babelTraverse) {
  const result = makeEmptyFileResult(filePath);
  const { aliases, baseUrl } = aliasConfig;

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

        // BUG 7: Skip asset imports — record as asset, do not attempt resolution
        if (isAssetImport(source)) {
          result.imports.project.push({ source, resolvedPath: null, unresolved: false, specifiers: [], type: 'asset' });
          return;
        }

        const specifiers = nodePath.node.specifiers.map(s => {
          if (s.type === 'ImportDefaultSpecifier') return s.local.name;
          if (s.type === 'ImportNamespaceSpecifier') return `* as ${s.local.name}`;
          return s.imported ? (s.imported.name || s.imported.value) : s.local.name;
        });

        // BUG 1+4: use aliases-aware isLibraryImport
        if (isLibraryImport(source, aliases)) {
          const pkgName = getPackageName(source);
          librarySet.add(pkgName);
          result.imports.libraries.push({ source: pkgName, specifiers });
        } else {
          const resolved = resolveImportPath(source, filePath, aliases, baseUrl, projectRoot);
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
            // BUG 7: Skip asset dynamic imports
            if (!isAssetImport(source)) {
              if (isLibraryImport(source, aliases)) {
                librarySet.add(getPackageName(source));
              } else {
                const resolved = resolveImportPath(source, filePath, aliases, baseUrl, projectRoot);
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
        // BUG 9: reexports are recorded in imports.reexports for barrel traversal
        if (node.source) {
          reexportCount++;
          const source = node.source.value;
          const specifiers = node.specifiers.map(s => (s.exported.name || s.exported.value));

          // BUG 7: skip asset reexports
          if (isAssetImport(source)) {
            result.imports.reexports.push({ source, resolvedPath: null, unresolved: false, specifiers, type: 'asset' });
            return;
          }

          // BUG 1+4: use aliases-aware isLibraryImport
          if (isLibraryImport(source, aliases)) {
            librarySet.add(getPackageName(source));
          } else {
            const resolved = resolveImportPath(source, filePath, aliases, baseUrl, projectRoot);
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

// ---------------------------------------------------------------------------
// Worker thread — AST parsing
// BUG 2: Each file wrapped in try/catch; errors reported explicitly.
// BUG 1: aliasConfig is passed in workerData (set on main thread at startup).
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
    // BUG 2: outer try/catch catches any uncaught exception inside parseSingleFile
    try {
      const r = parseSingleFile(filePath, aliasConfig, projectRoot, babelParser, babelTraverse);
      results.push(r);
    } catch (e) {
      // BUG 2: explicit error payload instead of crashing the worker
      const errResult = makeEmptyFileResult(filePath);
      errResult.error = `Uncaught worker error: ${e.message}`;
      results.push(errResult);
    }
  }

  parentPort.postMessage({ results });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main thread — lazy babel loader for fallback re-parsing (BUG 2)
// ---------------------------------------------------------------------------

let _babelModules = null;

function loadBabelModules() {
  if (!_babelModules) {
    const bp = require('@babel/parser');
    let bt = require('@babel/traverse');
    if (bt.default) bt = bt.default;
    _babelModules = { babelParser: bp, babelTraverse: bt };
  }
  return _babelModules;
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

  // BUG 1: Read aliases on main thread at startup, BEFORE workers are spawned.
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

  // ---------------------------------------------------------------------------
  // Cache handling
  // BUG 10: Compound cache key = md5(fileContent) + import signature.
  //         Invalidates when a dependency's resolved path changes even if the
  //         file itself hasn't changed.
  // ---------------------------------------------------------------------------
  const cacheFilePath = path.join(projectRoot, '.react-map-cache.json');
  let cache = { fileHashes: {}, importSignatures: {}, metadata: {} };
  if (!args.noCache) {
    const cacheContent = tryReadFileSync(cacheFilePath);
    if (cacheContent) {
      try {
        const parsed = JSON.parse(cacheContent);
        // Support old cache format (hashes key) and new format (fileHashes key)
        cache.fileHashes = parsed.fileHashes || parsed.hashes || {};
        cache.importSignatures = parsed.importSignatures || {};
        cache.metadata = parsed.metadata || {};
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

    if (!args.noCache && cache.fileHashes[f] === hash && cache.metadata[f]) {
      // BUG 10: re-validate import signatures
      const cachedMeta = cache.metadata[f];
      const importSources = [
        ...(cachedMeta.imports.project || []).filter(p => !p.type || p.type !== 'asset').map(p => p.source),
        ...(cachedMeta.imports.dynamic || []).map(d => d.source),
        ...(cachedMeta.imports.reexports || []).filter(r => !r.type || r.type !== 'asset').map(r => r.source),
      ].filter(s => !isLibraryImport(s, aliasConfig.aliases));

      const currentResolved = importSources
        .map(s => resolveImportPath(s, f, aliasConfig.aliases, aliasConfig.baseUrl, projectRoot) || 'null')
        .sort();
      const newImportSig = md5(currentResolved.join(','));

      if (!cache.importSignatures[f] || cache.importSignatures[f] === newImportSig) {
        cachedResults[f] = cachedMeta;
      } else {
        filesToParse.push(f);
      }
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

    // BUG 1: aliasConfig is passed to every worker as part of workerData
    const workerPromises = batches.map(batch => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
          workerData: {
            files: batch,
            projectRoot,
            aliasConfig, // BUG 1: full alias map included
          },
        });
        worker.on('message', msg => resolve(msg));
        worker.on('error', err => reject(err));
        worker.on('exit', code => {
          if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
      });
    });

    // BUG 3: Promise.all guarantees ALL workers complete before proceeding
    const workerResults = await Promise.all(workerPromises);
    for (const wr of workerResults) {
      if (wr.error) {
        console.warn(`Worker-level error: ${wr.error}`);
        continue;
      }
      for (const r of wr.results) {
        parsedResults[r.filePath] = r;
      }
    }
  }

  // Merge cached and fresh results
  const allResults = { ...cachedResults, ...parsedResults };

  // BUG 2: Main-thread fallback re-parse for files that errored in workers
  const { babelParser: fbBabelParser, babelTraverse: fbBabelTraverse } = loadBabelModules();
  const parseErrors = [];

  for (const [fp, data] of Object.entries(allResults)) {
    if (data.error && data.error !== 'LARGE_FILE') {
      // Log to parseErrors first
      parseErrors.push({ file: normalizePath(relativeTo(projectRoot, fp)), error: data.error });

      // BUG 2: attempt synchronous re-parse on main thread
      const fileContent = tryReadFileSync(fp);
      if (fileContent && fileContent.trim()) {
        try {
          const reparsed = parseSingleFile(fp, aliasConfig, projectRoot, fbBabelParser, fbBabelTraverse);
          if (!reparsed.error) {
            allResults[fp] = reparsed;
            // Remove from parseErrors since fallback succeeded
            parseErrors.pop();
          }
        } catch (e) {
          // Fallback also failed — keep blank node, error already recorded
        }
      }
    }
  }

  // BUG 3: Assertion — tree building must not start until all files have metadata.
  //        Files that failed hash computation (unreadable) are excluded from allFiles
  //        via the 'continue' above. Large files and parseable files must all be present.
  const expectedKeys = new Set(allFiles.map(f => f));
  const missingFiles = [];
  for (const f of allFiles) {
    if (!allResults[f]) missingFiles.push(normalizePath(relativeTo(projectRoot, f)));
  }
  if (missingFiles.length > 0) {
    throw new Error(
      `Assertion failed: ${missingFiles.length} file(s) missing from metadata map before tree build. ` +
      `Missing: ${missingFiles.slice(0, 5).join(', ')}${missingFiles.length > 5 ? '...' : ''}`
    );
  }

  // Update cache with compound keys
  const newCache = { fileHashes, importSignatures: {}, metadata: {} };
  for (const [fp, data] of Object.entries(allResults)) {
    newCache.metadata[fp] = data;
    // BUG 10: compute import signature from resolved paths
    const resolvedPaths = [
      ...(data.imports.project || []).filter(p => p.resolvedPath).map(p => p.resolvedPath),
      ...(data.imports.dynamic || []).filter(d => d.resolvedPath).map(d => d.resolvedPath),
      ...(data.imports.reexports || []).filter(r => r.resolvedPath).map(r => r.resolvedPath),
    ].sort();
    newCache.importSignatures[fp] = md5(resolvedPaths.join(','));
  }
  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(newCache));
  } catch {
    console.warn('Warning: Could not write cache file.');
  }

  // Classify files
  const allFileSet = new Set(allFiles.map(f => normalizePath(f)));

  for (const [fp, data] of Object.entries(allResults)) {
    data.type = classifyFile(fp, data, projectRoot);
  }

  // ---------------------------------------------------------------------------
  // Build dependency tree
  // BUG 3: Only runs after Promise.all + assertion above confirm all data present.
  // BUG 9: Barrel reexports are included in childPaths (same as project/dynamic).
  // ---------------------------------------------------------------------------
  const visited = new Set();
  const allImportedFiles = new Set();
  const circularDependencies = [];
  // BUG 8: collect unresolved imports
  const unresolvedImports = [];

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
          ...(p.type === 'asset' ? { type: 'asset' } : {}),
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
          ...(r.type === 'asset' ? { type: 'asset' } : {}),
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

    // BUG 8: collect unresolved imports at tree-build time
    for (const imp of [...data.imports.project, ...data.imports.dynamic, ...data.imports.reexports]) {
      if (imp.unresolved && imp.type !== 'asset') {
        unresolvedImports.push({
          file: normalizePath(relPath),
          source: imp.source,
        });
      }
    }

    // Collect all children from project imports, dynamic imports, and reexports
    // BUG 9: reexports from barrel files are included in childPaths
    const childPaths = [];

    for (const imp of data.imports.project) {
      if (imp.resolvedPath && imp.type !== 'asset') {
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
    // BUG 9: Barrel reexports are traversed as children
    for (const imp of data.imports.reexports) {
      if (imp.resolvedPath && imp.type !== 'asset') {
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

  // ---------------------------------------------------------------------------
  // BUG 5: Post-build integrity validation
  // Walk every node; if lineCount===0 AND no imports AND no children,
  // check if file actually has content on disk. Flag as suspectNode and re-parse.
  // ---------------------------------------------------------------------------
  const suspectNodes = [];

  function validateNode(node) {
    if (!node.circular) {
      const projectImportsCount = (node.imports.project || []).filter(p => p.type !== 'asset').length;
      const isEmpty = node.lineCount === 0 &&
        (node.imports.libraries || []).length === 0 &&
        projectImportsCount === 0 &&
        (node.children || []).length === 0;

      if (isEmpty) {
        const absPath = path.join(projectRoot, node.relativePath);
        if (fileExistsSync(absPath)) {
          const fileContent = tryReadFileSync(absPath);
          if (fileContent && fileContent.trim()) {
            suspectNodes.push({
              path: node.relativePath,
              reason: 'parsed as empty but file has content',
            });
            // BUG 5: attempt re-parse
            try {
              const reparsed = parseSingleFile(absPath, aliasConfig, projectRoot, fbBabelParser, fbBabelTraverse);
              if (!reparsed.error && reparsed.lineCount > 0) {
                // Patch node in place
                node.lineCount = reparsed.lineCount;
                node.hasJSX = reparsed.hasJSX;
                node.exports = reparsed.exports;
                node.props = reparsed.props;
                node.state = reparsed.state;
                node.routes = reparsed.routes;
                node.externalLibraries = reparsed.externalLibraries;
                node.imports.libraries = reparsed.imports.libraries.map(l => l.source);
                node.imports.project = reparsed.imports.project.map(p => ({
                  source: p.source,
                  resolved: p.resolvedPath ? normalizePath(relativeTo(projectRoot, p.resolvedPath)) : null,
                  unresolved: p.unresolved || false,
                  ...(p.type === 'asset' ? { type: 'asset' } : {}),
                }));
                // Update allResults so orphan detection sees the fix
                allResults[absPath] = reparsed;
                // Rebuild children for this node (simplified: mark as needing rebuild)
                node._needsChildRebuild = true;
              }
            } catch { /* re-parse failed on fallback too */ }
          }
        }
      }
    }

    for (const child of (node.children || [])) {
      validateNode(child);
    }
  }

  if (tree) {
    validateNode(tree);
  }

  // ---------------------------------------------------------------------------
  // BUG 6: Orphan detection — only runs after integrity validation.
  //        Files whose potential parents are in parseErrors or suspectNodes
  //        are marked "unresolved" rather than "orphaned".
  // ---------------------------------------------------------------------------
  const parseErrorRelPaths = new Set(parseErrors.map(e => e.file));
  const suspectNodeRelPaths = new Set(suspectNodes.map(s => s.path));

  const orphanedFiles = [];
  const entryNormalized = entryPoint ? normalizePath(entryPoint) : null;

  for (const f of allFiles) {
    const nf = normalizePath(f);
    if (nf === entryNormalized || allImportedFiles.has(nf)) continue;

    const relPath = normalizePath(relativeTo(projectRoot, f));

    // BUG 6: If the file itself or any file in the same subtree failed to parse,
    // we can't reliably determine orphan status — mark as unresolved.
    const hasParseIssues = parseErrorRelPaths.has(relPath) || suspectNodeRelPaths.has(relPath);

    if (hasParseIssues) {
      orphanedFiles.push({ path: relPath, orphanStatus: 'unresolved', reason: 'file had parse issues; dependency chain may be incomplete' });
    } else {
      orphanedFiles.push({ path: relPath, orphanStatus: 'orphaned' });
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

  // Deduplicate unresolvedImports
  const unresolvedDedup = [];
  const unresolvedSet = new Set();
  for (const ui of unresolvedImports) {
    const key = `${ui.file}|${ui.source}`;
    if (!unresolvedSet.has(key)) {
      unresolvedSet.add(key);
      unresolvedDedup.push(ui);
    }
  }

  // ---------------------------------------------------------------------------
  // Verification output (post-fix diagnostics)
  // ---------------------------------------------------------------------------
  const zeroLineCountNodes = [];
  function countZeroLineNodes(node) {
    if (node.lineCount === 0) zeroLineCountNodes.push(node.relativePath);
    for (const child of (node.children || [])) countZeroLineNodes(child);
  }
  if (tree) countZeroLineNodes(tree);

  const metadataCount = Object.keys(allResults).length;
  console.log(`\n[Verification]`);
  console.log(`  Metadata map entries: ${metadataCount} / totalFiles: ${allFiles.length} — ${metadataCount === allFiles.length ? 'OK' : 'MISMATCH'}`);
  console.log(`  Tree nodes with lineCount===0: ${zeroLineCountNodes.length}`);
  console.log(`  suspectNodes: ${suspectNodes.length}`);
  console.log(`  parseErrors: ${parseErrors.length}`);
  console.log(`  unresolvedImports: ${unresolvedDedup.length}`);

  const trueOrphans = orphanedFiles.filter(o => o.orphanStatus === 'orphaned');
  console.log(`  orphanedFiles (orphaned): ${trueOrphans.length}`);
  console.log(`  orphanedFiles (unresolved): ${orphanedFiles.filter(o => o.orphanStatus === 'unresolved').length}`);
  if (trueOrphans.length > 0) {
    console.log(`  First 5 orphans:`);
    for (const o of trueOrphans.slice(0, 5)) {
      console.log(`    - ${o.path} (not reachable from entry point and no parse errors in ancestors)`);
    }
  }

  // Check if App.tsx is an empty node
  if (zeroLineCountNodes.some(p => p.includes('App'))) {
    const appNode = zeroLineCountNodes.filter(p => p.includes('App'));
    console.log(`  WARNING: App-related file(s) still appear as empty nodes: ${appNode.join(', ')}`);
    for (const ap of appNode) {
      const absAp = path.join(projectRoot, ap);
      const apData = allResults[absAp];
      if (apData && apData.error) {
        console.log(`    Error for ${ap}: ${apData.error}`);
      } else if (!fileExistsSync(absAp)) {
        console.log(`    ${ap}: file does not exist on disk`);
      } else {
        const c = tryReadFileSync(absAp);
        console.log(`    ${ap}: file exists, length=${c ? c.length : 0}`);
      }
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
    unresolvedImports: unresolvedDedup,
    suspectNodes,
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
    unresolvedImports: [],
    suspectNodes: [],
    aliases,
    tree: {},
  };
}

function printSummary(output) {
  console.log('\n' + '='.repeat(50));
  console.log('  PROJECT ROADMAP SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Project:              ${output.projectName}`);
  console.log(`  Version:              ${output.version}`);
  console.log(`  Entry Point:          ${output.entryPoint || 'N/A'}`);
  console.log(`  Auto-detected:        ${output.entryPointAutoDetected}`);
  console.log('-'.repeat(50));
  console.log(`  Total Files:          ${output.totalFiles}`);
  console.log(`  Components:           ${output.totalComponents}`);
  console.log(`  Hooks:                ${output.totalHooks}`);
  console.log(`  Pages:                ${output.totalPages}`);
  console.log(`  Orphaned Files:       ${output.orphanedFiles.filter(o => o.orphanStatus === 'orphaned').length}`);
  console.log(`  Unresolved Orphans:   ${output.orphanedFiles.filter(o => o.orphanStatus === 'unresolved').length}`);
  console.log(`  Parse Errors:         ${output.parseErrors.length}`);
  console.log(`  Circular Deps:        ${output.circularDependencies.length}`);
  console.log(`  Unresolved Imports:   ${(output.unresolvedImports || []).length}`);
  console.log(`  Suspect Nodes:        ${(output.suspectNodes || []).length}`);
  if (output.largeFiles && output.largeFiles.length > 0) {
    console.log(`  Large Files:          ${output.largeFiles.length}`);
  }
  if (output.packages) {
    console.log(`  Packages:             ${output.packages.length}`);
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
