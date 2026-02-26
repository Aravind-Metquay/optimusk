# react-map.js

A production-grade React/TypeScript project architecture crawler. Run it against any React project to generate a comprehensive `project-roadmap.json` describing the full dependency tree, component classification, props, state, routes, and more.

## What Has Been Done

### Core Script (`react-map.js`)

A single-file, fully self-contained Node.js script (no build step required) that performs deep static analysis of React projects:

**File Discovery**
- Recursively walks the project directory collecting `.js`, `.jsx`, `.ts`, `.tsx` files
- Auto-excludes `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`, `coverage`, `.nyc_output`
- Skips test/spec/stories files and `.d.ts` declaration files
- Supports a `.react-map-ignore` file for custom exclusions

**Entry Point Detection**
- Checks `src/main.tsx`, `src/main.ts`, `src/index.tsx`, `src/index.ts`, `src/index.js`, `index.js`, `index.tsx` in priority order
- Falls back to the first `.tsx`/`.ts` file found and flags `entryPointAutoDetected: true`
- Can be overridden with the `--entry` flag

**AST Parsing & Import Extraction**
- Parses every file using `@babel/parser` with TypeScript, JSX, decorators, dynamic import, and other plugins
- Categorizes imports into: library, project, dynamic (`import()`), and re-exports (`export { X } from`)
- Resolves path aliases from `tsconfig.json` / `jsconfig.json` (`compilerOptions.paths` and `baseUrl`)
- Tries `.tsx`, `.ts`, `.jsx`, `.js`, and `/index.*` extensions when resolving extensionless imports

**Component Classification**
- **Hook** — filename starts with `use` (e.g., `useAuth.ts`)
- **Context** — filename contains `Context`/`Provider`, or file uses `createContext`
- **Page** — lives in `pages/`, `views/`, `screens/`, or name ends with `Page`/`View`
- **Layout** — lives in `layouts/` or name contains `Layout`
- **Router** — uses `BrowserRouter`, `Routes`, `Route`, `createBrowserRouter`
- **Store** — uses `createSlice`, `configureStore`, `atom()`, zustand `create()`
- **Utility** — in `utils/`, `helpers/`, or `lib/` with no JSX
- **Barrel** — index file that only re-exports
- **TypeDefinition** — only type exports, no runtime code
- **Component** — any file with JSX (default fallback)
- **Module** — everything else

**Metadata Extraction (per file)**
- **Props**: from TypeScript interfaces/types ending in `Props` and inline destructured params
- **State**: `useState` variable names and `useReducer` calls
- **Routes**: string literals from `<Route path="...">`, `navigate()`, `router.push()`
- **Exports**: named and default, classified as function/class/constant/type
- **External libraries**: every unique library import
- **Line count**, **last modified** (ISO timestamp), **has tests** (checks for sibling test/spec files)

**Dependency Tree**
- Depth-first recursive traversal starting from the entry point
- Circular dependency detection (marks nodes `circular: true`, collects pairs in `circularDependencies`)
- Orphaned file detection (files on disk but never imported)

**Performance**
- Worker thread parallelism — one worker per CPU core minus one
- MD5-based caching in `.react-map-cache.json` — skips unchanged files on subsequent runs
- `--no-cache` flag for forced full rescans

**Edge Case Handling**
- Binary/non-UTF8 files — caught and skipped
- Empty files — parsed as Module with no imports
- Files > 500KB — skipped from AST parsing, listed in `largeFiles` array
- Barrel files — detected and marked
- Type-only files — classified as `TypeDefinition`
- Monorepo support — scans `packages/` subdirectories
- Missing `package.json` — uses folder name and `0.0.0`
- Unresolvable aliases — included with `unresolved: true`
- Windows paths — normalized to forward slashes

## Getting Started

### Prerequisites

- **Node.js** >= 16 (uses `worker_threads`, `fs`, `path`, `os`, `crypto`)

### Installation

```bash
# Clone the repository
git clone https://github.com/Aravind-Metquay/optimusk.git
cd optimusk

# Install dependencies (only two: @babel/parser and @babel/traverse)
npm install @babel/parser @babel/traverse
```

> **Note:** If you skip the install step, the script will auto-install the missing packages on first run.

### Usage

```bash
# Basic — scan a React project and output project-roadmap.json in the current directory
node react-map.js /path/to/your/react-project

# Pretty-printed output with terminal summary
node react-map.js /path/to/your/react-project --pretty --summary

# Custom output location
node react-map.js ./my-app --output ./reports/roadmap.json --pretty

# Force full rescan (ignore cache)
node react-map.js ./my-app --no-cache

# Specify entry point manually
node react-map.js ./my-app --entry src/app/root.tsx

# Exclude additional patterns
node react-map.js ./my-app --exclude "*.config.*" --exclude "scripts"

# Default to current directory
node react-map.js --pretty --summary
```

### CLI Flags

| Flag | Description |
|---|---|
| `--no-cache` | Ignore `.react-map-cache.json` and rescan all files |
| `--exclude <glob>` | Additional glob pattern to exclude (repeatable) |
| `--output <path>` | Custom output file path (default: `./project-roadmap.json`) |
| `--entry <path>` | Manually specify the entry point file |
| `--pretty` | Pretty-print JSON with 2-space indentation |
| `--summary` | Print a human-readable summary table to the terminal |

### Output

The script generates a `project-roadmap.json` with this structure:

```json
{
  "projectName": "my-app",
  "version": "1.0.0",
  "scannedAt": "2026-02-26T09:00:00.000Z",
  "entryPoint": "src/main.tsx",
  "entryPointAutoDetected": false,
  "totalFiles": 42,
  "totalComponents": 15,
  "totalHooks": 8,
  "totalPages": 5,
  "parseErrors": [],
  "circularDependencies": [],
  "orphanedFiles": [],
  "aliases": { "@": "src" },
  "tree": {
    "name": "main.tsx",
    "path": "/src/main.tsx",
    "relativePath": "src/main.tsx",
    "type": "Root",
    "lineCount": 12,
    "lastModified": "2026-02-26T08:00:00.000Z",
    "hasTests": false,
    "imports": { "libraries": [], "project": [], "dynamic": [], "reexports": [] },
    "props": [],
    "state": [],
    "routes": [],
    "exports": [],
    "externalLibraries": [],
    "circular": false,
    "children": [ "..." ]
  }
}
```

## What To Do Next

### Short Term

1. **Add unit tests** — Create a test suite (e.g., with Jest or Vitest) covering:
   - File discovery and exclusion logic
   - AST parsing of various import styles
   - Component classification rules
   - Path alias resolution
   - Circular dependency detection
   - Edge cases (empty files, barrel files, type-only files, large files)

2. **Add a `package.json`** — Define the project properly with `name`, `version`, `bin` field (to enable `npx react-map`), and `dependencies` for `@babel/parser` and `@babel/traverse`.

3. **Publish as an npm package** — Allow users to run `npx react-map ./my-project --pretty --summary` without cloning.

### Medium Term

4. **HTML/interactive report** — Generate a visual dependency graph (e.g., D3.js tree or force-directed graph) from the JSON output.

5. **Watch mode** — Add a `--watch` flag that re-scans on file changes using `fs.watch` and updates the JSON incrementally.

6. **Deeper analysis**:
   - Extract `useEffect` dependency arrays
   - Detect render prop patterns and HOCs
   - Map Context consumers to their providers
   - Detect unused exports within the project
   - Track component composition depth

7. **Framework-specific support**:
   - Next.js `app/` directory routing conventions
   - Remix loader/action detection
   - Vite/Webpack config parsing for aliases

### Long Term

8. **CI integration** — GitHub Action that runs on PRs and comments a diff of the architecture (new components, removed files, changed dependency chains).

9. **VS Code extension** — Visualize the dependency tree inline in the editor with clickable navigation.

10. **Multi-project dashboard** — Aggregate `project-roadmap.json` from multiple repos into a single architecture overview for monorepos or microservice setups.

## Project Structure

```
optimusk/
├── react-map.js          # The main crawler script (single file, ~1,360 lines)
├── .gitignore            # Ignores node_modules, cache, and output files
├── README.md             # This file
└── node_modules/         # Dependencies (auto-installed)
    ├── @babel/parser
    └── @babel/traverse
```

## License

MIT
