Here is a comprehensive prompt you can paste directly into Claude Code:

---

Build a production-grade React project architecture crawler as a single executable Node.js script called `react-map.js`. When run with `node react-map.js <project-path>`, it should analyze the entire React/TypeScript project at that path and output a `project-roadmap.json` file in the current working directory.

---

**CORE REQUIREMENTS**

The script must accept a file path as a CLI argument (`process.argv[2]`). If no path is provided, it should default to the current directory. If the path doesn't exist or isn't a directory, exit with a clear error message.

---

**FILE DISCOVERY**

Recursively walk the project directory and collect all files matching these extensions: `.js`, `.jsx`, `.ts`, `.tsx`. Automatically exclude these directories and patterns:

- `node_modules`
- `.git`
- `dist`, `build`, `out`, `.next`, `.nuxt`
- `coverage`, `.nyc_output`
- `*.test.*`, `*.spec.*`, `*.stories.*`
- `*.d.ts`
- Any folder listed in a `.react-map-ignore` file at the project root if it exists

---

**ENTRY POINT DETECTION**

Automatically detect the entry point by checking for these files in order of priority:

1. `src/main.tsx`
2. `src/main.ts`
3. `src/index.tsx`
4. `src/index.ts`
5. `src/index.js`
6. `index.js`
7. `index.tsx`

If none are found, use the first `.tsx` or `.ts` file discovered, and flag it as `"entryPointAutoDetected": true` in the JSON output.

---

**AST PARSING — IMPORT EXTRACTION**

For each file, parse it using `@babel/parser` with these plugins enabled: `typescript`, `jsx`, `decorators-legacy`, `classProperties`, `dynamicImport`, `exportDefaultFrom`, `importMeta`. Extract every import and categorize them:

- **Library imports**: the source starts with a letter and has no `.` or `/` prefix (e.g., `react`, `react-router-dom`, `axios`). Capture the package name only (first segment before any `/`).
- **Project imports**: starts with `./`, `../`, or a configured path alias (read `tsconfig.json` or `jsconfig.json` for `compilerOptions.paths` and `compilerOptions.baseUrl`). Resolve the full absolute path including trying these extensions in order if the import has no extension: `.tsx`, `.ts`, `.jsx`, `.js`, `/index.tsx`, `/index.ts`, `/index.jsx`, `/index.js`.
- **Dynamic imports**: `import('./SomeComponent')` — mark these with `"isDynamic": true`.
- **Re-exports**: `export { X } from './Y'` — capture these as a special import type `"reexport"`.

If a file fails to parse, do not crash. Instead, log a warning and add the file to a top-level `"parseErrors"` array in the JSON with the filename and error message.

---

**COMPONENT CLASSIFICATION — INTENT DETECTION**

For every file, determine its `type` using this priority-ordered rule system:

1. **Hook** — filename starts with `use` (case-sensitive), e.g., `useAuth.ts`
2. **Context** — filename contains `Context` or `Provider`, or the file contains `createContext` or `React.createContext`
3. **Page** — file lives inside a folder named `pages`, `views`, or `screens`, OR the file's name ends in `Page` or `View`
4. **Layout** — file lives in a folder named `layouts`, or filename contains `Layout`
5. **Router** — file contains `createBrowserRouter`, `BrowserRouter`, `Routes`, `Route` from `react-router-dom` or `react-router`
6. **Store** — file contains `createSlice`, `createStore`, `configureStore`, `atom(` (Jotai), `create(` with zustand patterns
7. **Utility** — file is in a `utils`, `helpers`, or `lib` folder and has no JSX
8. **Component** — default fallback for any file with JSX or that exports a capitalized function

If the file has no JSX and no default export of a capitalized name, mark it as `"type": "Module"`.

---

**METADATA EXTRACTION**

For each file node, extract:

**Props**: Find the TypeScript interface or type that ends in `Props` (e.g., `ButtonProps`, `CardProps`). Extract each property name and its type as a string. Also detect inline prop destructuring in function signatures like `({ user, onLogout }: Props)` and capture those names. If no props are found, set `"props": []`.

**State**: Detect all `useState` calls and capture the state variable name (first element of the destructured array). Detect `useReducer` and mark it as `"type": "reducer"`. If none found, set `"state": []`.

**Routes**: Find all string literals passed to the `path` prop of a `<Route>` component. Also find strings passed to `navigate()`, `useNavigate()`, or `router.push()`. Deduplicate and collect into a `"routes"` array. If none, set `"routes": []`.

**Exports**: Capture all named and default exports. Mark whether each is a function, class, constant, or type.

**External Libraries Used**: List every unique library import in the file (not project imports).

**Line Count**: Include `"lineCount"` as the total number of lines in the file.

**Last Modified**: Include `"lastModified"` as the ISO timestamp from the file's `fs.stat`.

**Has Tests**: Check if a corresponding `*.test.*` or `*.spec.*` file exists alongside it. Set `"hasTests": true` or `false`.

---

**DEPENDENCY GRAPH & TREE BUILDING**

After parsing all files, build the dependency tree starting from the entry point. Use a depth-first recursive traversal. Track visited nodes using a `Set` of absolute paths to prevent infinite loops from circular dependencies. If a circular dependency is detected, add the node but set `"circular": true` and do not recurse further. Add all detected circular pairs to a top-level `"circularDependencies"` array.

Files that are discovered on disk but never imported by any other file (and are not the entry point) should be collected into a top-level `"orphanedFiles"` array. These are potential dead code.

---

**OUTPUT JSON STRUCTURE**

The final `project-roadmap.json` must follow this exact shape:

```json
{
  "projectName": "<name from package.json, or folder name>",
  "version": "<version from package.json or '0.0.0'>",
  "scannedAt": "<ISO timestamp>",
  "entryPoint": "<relative path>",
  "entryPointAutoDetected": false,
  "totalFiles": 0,
  "totalComponents": 0,
  "totalHooks": 0,
  "totalPages": 0,
  "parseErrors": [],
  "circularDependencies": [],
  "orphanedFiles": [],
  "aliases": {},
  "tree": {
    "name": "main.tsx",
    "path": "/src/main.tsx",
    "relativePath": "src/main.tsx",
    "type": "Root",
    "lineCount": 0,
    "lastModified": "",
    "hasTests": false,
    "imports": {
      "libraries": [],
      "project": [],
      "dynamic": [],
      "reexports": []
    },
    "props": [],
    "state": [],
    "routes": [],
    "exports": [],
    "externalLibraries": [],
    "circular": false,
    "children": []
  }
}
```

---

**ERROR HANDLING & EDGE CASES**

Handle every one of these scenarios without crashing:

- Binary files or non-UTF8 files accidentally matched — catch the read error and skip
- Empty files — parse as a Module with no imports
- Files with only type exports and no runtime code — classify as `"type": "TypeDefinition"`
- Barrel files (`index.ts` that only re-exports) — detect and mark as `"type": "Barrel"`
- Monorepo structures — if a `packages/` directory is found at the root, scan each sub-package separately and include them under a top-level `"packages"` array
- `package.json` missing — use the folder name as `projectName` and `"0.0.0"` as version
- Path aliases that can't be resolved — include the import as-is with `"unresolved": true`
- Files larger than 500KB — skip AST parsing, add to a `"largeFiles"` array, still include in the tree with basic metadata only
- Windows-style paths — normalize all paths to forward slashes

---

**PERFORMANCE**

Use Node.js `worker_threads` to parse files in parallel. Spawn one worker per CPU core minus one (use `os.cpus().length - 1`, minimum 1). Each worker receives a batch of file paths and returns parsed metadata. The main thread assembles the tree after all workers complete.

Implement MD5-based caching: store a `.react-map-cache.json` file in the project root containing `{ "filePath": "md5hash" }`. On subsequent runs, skip re-parsing files whose MD5 hash hasn't changed and reuse cached metadata. Add a `--no-cache` flag to force a full rescan.

---

**CLI FLAGS**

Support these optional flags:

- `--no-cache` — ignore existing cache and do a full scan
- `--exclude <glob>` — additional glob pattern to exclude (can be used multiple times)
- `--output <path>` — custom output path for the JSON file
- `--entry <path>` — manually specify the entry point
- `--pretty` — pretty-print the JSON with 2-space indentation (default is minified)
- `--summary` — after writing the file, print a human-readable summary table to the terminal showing total files, components, hooks, pages, orphaned files, and parse errors

---

**DEPENDENCIES**

Only use these npm packages (install them if not present by running `npm install` automatically at the start of the script if they are missing from `node_modules`):

- `@babel/parser` — for AST parsing
- `@babel/traverse` — for walking the AST nodes
- `glob` — for file discovery
- `crypto` — built-in, for MD5 hashing

Do not use any other third-party packages. All other functionality must use Node.js built-ins (`fs`, `path`, `os`, `worker_threads`, `readline`).

---

**FINAL INSTRUCTION**

Write the complete, fully working script in a single file `react-map.js`. Do not use placeholders or TODOs. Every feature described above must be implemented and functional. After writing the script, run it against the current directory as a smoke test and show the terminal output.

---

This prompt covers every edge case from the spec. When Claude Code runs it, you should get a fully working script on the first pass.
