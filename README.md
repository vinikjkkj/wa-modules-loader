# WA Modules Loader

A tiny, TypeScript-first toolkit to work with deobfuscated WhatsApp Web modules.

- Minimal Metro-like runtime loader for module files extracted from the bundle
- Register any extra dependency at runtime (sync or async)
- Batteries included shims (Promise, asyncToGeneratorRuntime, err, babelHelpers)
- A small CLI to split a Metro bundle into individual module files

> Requires Node.js >= 18

---

## Table of Contents

- [Install](#install)
- [Build (repo)](#build-repo)
- [CLI: Export modules](#cli-export-modules)
- [Programmatic Export API](#programmatic-export-api)
- [Library: Load and use modules](#library-load-and-use-modules)
- [Register external modules](#register-external-modules)
- [License](#license)

---

## Install

If you are using this as a dependency in another project:

```bash
npm i wa-modules-loader
# or
pnpm add wa-modules-loader
# or
yarn add wa-modules-loader
```

This repository itself ships compiled code in `dist/` when you run the build.

## Build (repo)

When working inside this repo:

```bash
npm install
npm run build
```

This compiles TypeScript from `src/` to `dist/`.

---

## CLI: Export modules

The CLI splits a Metro bundle into multiple files — one per module occurrence —
based on the `__d(` marker.

```bash
# Syntax
wa-export <inputFile.js> <outputDir?>

# Examples (Windows paths)
wa-export C:\path\to\wa-bundle.js C:\path\to\out\deobfuscated

# If <outputDir> is omitted, it defaults to:
# <inputDir>/deobfuscated/<inputNameWithoutExt>

# Export only modules whose names match a regex:
wa-export C:\path\to\wa-bundle.js C:\path\to\out --module-filter "Signal|Crypto"

# You can repeat --module-filter (OR behavior):
wa-export C:\path\to\wa-bundle.js C:\path\to\out --module-filter "/WASignal/i" --module-filter "WACrypto"
```

`--module-filter` is regex-based and can be repeated.  
Plain values are compiled as case-insensitive regex (`new RegExp(value, 'i')`), and `/pattern/flags` keeps the provided flags.

### Exporting straight from a URL

`--direct-url` skips the input file entirely and downloads the bundle itself. When
`--direct-url` is used there is no input positional, so the first positional is the output dir:

```bash
wa-export --direct-url <URL> C:\path\to\out

# Same flags as the file-based modes:
wa-export --direct-url <URL> C:\path\to\out --workers 8 --module-filter "^WASignal"
```

The URL may point at either:

- **a `.js` bundle** — downloaded and split like a local bundle;
- **a `.zip` release archive** — every entry is scanned, and each one that holds
  Metro modules is exported.

Archives are detected by their magic bytes, not by the URL or `Content-Type`.
The request is sent with browser-like headers, since these endpoints commonly
reject a bare fetch with HTTP 400.

Notes for archive input:

- **Non-`.js` entries are dropped** (a release archive also ships `.css` and
  other assets, which can never contain `__d(` modules).
- Output is **always flat** — archive entries are content-addressed by hash, so a
  subfolder per bundle would just be noise. Modules with the same name across
  different chunks collapse onto the same file. Use `--merge-common-names` to
  group by module name instead.
- ZIP64 archives are supported (required past 65535 entries), and entries are
  inflated one at a time, so a multi-GB archive never has to fit in memory.

Each file produced still contains the original function wrapper used by Metro.
These files are later consumed by the library loader.

> Tip: If you are developing locally and want to try the CLI globally, run `npm link` in the repo. That will make the `wa-export` command available in your shell.

---

## Programmatic Export API

You can also run the exporter from code (without shelling out to the CLI):

```ts
import { exportModules } from 'wa-modules-loader'

const result = await exportModules({
    inputFile: 'C:/path/to/wa-bundle.js',
    outputDir: 'C:/path/to/out/deobfuscated',
    mergeCommonNames: true,
    moduleNameFilters: ['WASignal', '/Crypto/i'],
    workers: 4
})

console.log(result)
// {
//   inputFile: 'C:/path/to/wa-bundle.js',
//   outputDir: 'C:/path/to/out/deobfuscated',
//   mode: 'js',
//   bundlesProcessed: 1,
//   filesWritten: 1234,
//   skippedBundles: 0
// }
```

`exportModules()` supports `.js` and `.json` inputs and uses the same behavior/flags as the CLI (`toIa`, `mergeCommonNames`, `workers`, `concurrency`, `flat`/`noSubdirs`, `moduleNameFilters`).

Pass `directUrl` instead of `inputFile` to download the bundle or release archive
directly (see [Exporting straight from a URL](#exporting-straight-from-a-url)).
Passing both is an error. `onProgress` is called as bundles complete, which is
useful for archives holding tens of thousands of them:

```ts
const result = await exportModules({
    directUrl: 'https://example.com/release.zip',
    outputDir: 'C:/path/to/out/deobfuscated',
    moduleNameFilters: ['^WASignal'],
    workers: 8,
    onProgress: (done, total) => console.error(`${done}/${total}`)
})

console.log(result.mode) // 'archive' for a .zip, 'url' for a single .js
```

---

## Library: Load and use modules

The library turns the exported module files back into runnable factories and resolves their dependencies by name (e.g. `b("SomeModule")`, `d("SomeModule")`). You are in full control of which modules to load – there is no built-in hardcoded list.

```ts
import { ModuleRegistry, registerAll, type ModuleSpec } from 'wa-modules-loader'

async function main() {
    // 1) Prepare your module list (absolute file paths)
    const modules: ModuleSpec[] = [
        { name: 'WASignalKeys', path: 'C:/abs/path/deobfuscated/mMxGWPzRoXp/WASignalKeys.js' },
        {
            name: 'WACryptoPrimitives',
            path: 'C:/abs/path/deobfuscated/mMxGWPzRoXp/WACryptoPrimitives.js'
        }
        // ...add as many as you need
    ]

    // 2) Create a registry and register all modules
    const registry = new ModuleRegistry()
    await registerAll(registry, modules)

    // 3) Resolve and use modules by name
    const WASignalKeys = registry.require<any>('WASignalKeys')
    // ... use WASignalKeys API as needed
}

main().catch(console.error)
```

What `registerAll()` provides for you:

- Sets up a few runtime shims commonly expected by the bundle (Promise, asyncToGeneratorRuntime, err, babelHelpers)
- Ensures a WebCrypto implementation is available as `globalThis.crypto` (via Node’s `webcrypto`)
- Parses each module file, extracts the function expression, and registers a standardized factory in the registry

> Important: Pass absolute file paths in `ModuleSpec.path`.

---

## Register external modules

Sometimes a WA module expects a third-party dependency to be available by name. You can inject these at runtime.

- Sync value (object/function/constant):

```ts
registry.registerValue('my-utils', {
    add(a: number, b: number) {
        return a + b
    }
})
```

- Async loader (e.g., dynamic import):

```ts
await registry.registerAsync('tweetnacl', import('tweetnacl'))

// or with a custom loader function
await registry.registerAsync('my-lib', async () => {
    const mod = await import('some-lib')
    return mod // default export is unwrapped automatically if present
})
```

After registration, these names can be resolved by WA modules using the internal resolver (`b("name")` / `d("name")`).

## License

MIT
