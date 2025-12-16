#!/usr/bin/env node
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { minify } from 'terser'
import { Worker, isMainThread } from 'worker_threads'

function getArgValue(args: string[], flagName: string): string | null {
    const idx = args.indexOf(flagName)
    if (idx !== -1) {
        const val = idx + 1 < args.length ? args[idx + 1] : null
        if (!val || val.startsWith('-')) return null
        return val
    }
    const prefix = `${flagName}=`
    const found = args.find((a) => a.startsWith(prefix))
    return found ? found.slice(prefix.length) : null
}

function normalizeForMerge(name: string): string {
    return name.startsWith('WAWeb') ? name.slice('WAWeb'.length) : name
}

function safeNameComponent(name: string): string {
    const cleaned = name.replace(/[^\w\-\[\]]+/g, '_').trim()
    const raw = cleaned || 'group'
    const maxLen = 80
    if (raw.length <= maxLen) return raw
    const hash = createHash('sha1').update(raw).digest('hex').slice(0, 10)
    const prefixLen = Math.max(1, maxLen - (1 + hash.length))
    return `${raw.slice(0, prefixLen)}_${hash}`
}

function longestCommonPrefix(a: string, b: string): string {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return a.slice(0, i)
}

function computeMergePrefixes(
    rawNames: string[],
    minPrefixLen = 3,
    minMembers = 2
): Array<{ raw: string; norm: string }> {
    if (rawNames.length < minMembers) return []

    const items = rawNames
        .map((raw) => ({ raw, norm: normalizeForMerge(raw) }))
        .filter((x) => x.norm.length >= minPrefixLen)

    items.sort((a, b) => a.norm.localeCompare(b.norm))

    const prefixMembers = new Map<string, Set<string>>()

    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            const lcp = longestCommonPrefix(items[i].norm, items[j].norm)
            if (lcp.length < minPrefixLen) break
            if (!prefixMembers.has(lcp)) prefixMembers.set(lcp, new Set())
            prefixMembers.get(lcp)!.add(items[i].raw)
            prefixMembers.get(lcp)!.add(items[j].raw)
        }
    }

    const candidates = [...prefixMembers.entries()]
        .filter(([_, members]) => members.size >= minMembers)
        .sort((a, b) => b[0].length - a[0].length || b[1].size - a[1].size)

    const selected: string[] = []
    const covered = new Set<string>()

    for (const [prefix, members] of candidates) {
        const uncovered = [...members].filter((m) => !covered.has(m))
        if (uncovered.length >= minMembers) {
            selected.push(prefix)
            for (const m of members) covered.add(m)
        }
    }

    return selected.map((norm) => {
        const matching = items.filter((i) => i.norm.startsWith(norm))
        const withWAWeb = matching.filter((i) => i.raw.startsWith('WAWeb')).length
        const raw = withWAWeb > matching.length / 2 ? `WAWeb${norm}` : norm
        return { raw, norm }
    })
}

function pickMergeDir(
    rawName: string,
    prefixes: Array<{ raw: string; norm: string }>
): string | null {
    const norm = normalizeForMerge(rawName)

    const dotIdx = norm.lastIndexOf('.')
    if (dotIdx > 0) {
        const suffix = norm.slice(dotIdx + 1)
        let best: { raw: string; norm: string } | null = null
        for (const p of prefixes) {
            if (suffix === p.norm || suffix.startsWith(p.norm)) {
                if (!best || p.norm.length > best.norm.length) best = p
            }
        }
        if (best) return safeNameComponent(best.raw)
    }

    let best: { raw: string; norm: string } | null = null
    for (const p of prefixes) {
        if (norm.startsWith(p.norm)) {
            if (!best || p.norm.length > best.norm.length) best = p
        }
    }
    return best ? safeNameComponent(best.raw) : null
}

function hasFlag(args: string[], flagName: string): boolean {
    return args.includes(flagName) || args.some((a) => a.startsWith(`${flagName}=`))
}

function assertNoUnknownFlags(args: string[]) {
    const knownFlags = new Set([
        '--no-subdirs',
        '--flat',
        '--to-ia',
        '--concurrency',
        '--workers',
        '--merge-common-names',
        '--help',
        '-h'
    ])

    const unknown: string[] = []
    for (const a of args) {
        if (!a.startsWith('-')) continue
        const base = a.startsWith('--') ? a.split('=')[0] : a
        if (!knownFlags.has(base)) unknown.push(a)
    }
    if (unknown.length > 0) {
        throw new Error(`Unknown flag(s): ${unknown.join(', ')}`)
    }
}

async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>
) {
    const concurrency = Math.max(1, Math.floor(limit))
    let nextIdx = 0
    const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (true) {
            const idx = nextIdx
            nextIdx++
            if (idx >= items.length) return
            await worker(items[idx], idx)
        }
    })
    await Promise.all(runners)
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p)
        return true
    } catch {
        return false
    }
}

type ExportFile = {
    fileName: string
    content: string
}

type WorkerRequest = {
    id: number
    bundle: ArrayBuffer
    byteOffset: number
    byteLength: number
    disambiguate: boolean
    toIa: boolean
    mergeCommonNames: boolean
    mergeCommonPrefixes: string[] | null
}

type WorkerChunk = {
    id: number
    kind: 'chunk'
    files: Array<{
        fileName: string
        data: ArrayBuffer
        byteOffset: number
        byteLength: number
    }>
}

type WorkerDone = {
    id: number
    kind: 'done'
}

type WorkerError = {
    id: number
    kind: 'error'
    message: string
}

class WorkerPool {
    private readonly workers: Worker[]
    private nextWorkerIdx = 0
    private nextTaskId = 1
    private readonly tasks = new Map<
        number,
        {
            outDir: string
            writeChain: Promise<void>
            resolve: () => void
            reject: (e: Error) => void
        }
    >()

    constructor(count: number) {
        const workerPath = path.join(__dirname, 'worker.js')
        this.workers = new Array(count).fill(0).map(() => {
            const w = new Worker(workerPath)
            w.on('message', (msg: WorkerChunk | WorkerDone | WorkerError) => this.onMessage(msg))
            w.on('error', (e) => this.onWorkerError(e))
            return w
        })
    }

    private onWorkerError(e: Error) {
        for (const [id, t] of this.tasks) {
            this.tasks.delete(id)
            t.reject(e)
        }
    }

    private onMessage(msg: WorkerChunk | WorkerDone | WorkerError) {
        const t = this.tasks.get(msg.id)
        if (!t) return

        if (msg.kind === 'error') {
            this.tasks.delete(msg.id)
            t.reject(new Error(msg.message))
            return
        }

        if (msg.kind === 'chunk') {
            t.writeChain = t.writeChain.then(async () => {
                await runWithConcurrency(msg.files, 20, async (f) => {
                    const buf = Buffer.from(f.data, f.byteOffset, f.byteLength)
                    const filePath = path.join(t.outDir, f.fileName)
                    await fs.mkdir(path.dirname(filePath), { recursive: true })
                    await fs.writeFile(filePath, buf)
                })
            })
            return
        }

        t.writeChain
            .then(() => {
                this.tasks.delete(msg.id)
                t.resolve()
            })
            .catch((e) => {
                this.tasks.delete(msg.id)
                t.reject(e)
            })
    }

    async process(
        bundle: { buffer: ArrayBuffer; byteOffset: number; byteLength: number },
        outDir: string,
        opts: {
            disambiguate: boolean
            toIa: boolean
            mergeCommonNames: boolean
            mergeCommonPrefixes: string[] | null
        }
    ) {
        const id = this.nextTaskId++

        const p = new Promise<void>((resolve, reject) => {
            this.tasks.set(id, {
                outDir,
                writeChain: Promise.resolve(),
                resolve,
                reject
            })
        })

        const req: WorkerRequest = {
            id,
            bundle: bundle.buffer,
            byteOffset: bundle.byteOffset,
            byteLength: bundle.byteLength,
            disambiguate: opts.disambiguate,
            toIa: opts.toIa,
            mergeCommonNames: opts.mergeCommonNames,
            mergeCommonPrefixes: opts.mergeCommonPrefixes
        }

        const w = this.workers[this.nextWorkerIdx]
        this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length
        w.postMessage(req, [bundle.buffer])
        await p
    }

    async destroy() {
        await Promise.all(this.workers.map((w) => w.terminate()))
    }
}

function extractDCalls(source: string): string[] {
    const out: string[] = []
    let i = 0

    while (i < source.length) {
        const start = findNextDCallStart(source, i)
        if (start === -1) break

        try {
            const openParenIdx = start + '__d'.length
            const closeParenIdx = findMatchingParen(source, openParenIdx)
            let end = closeParenIdx + 1
            while (end < source.length && /\s/.test(source[end])) end++
            if (source[end] === ';') end++

            out.push(source.slice(start, end))
            i = end
        } catch (e: any) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e)
            console.error(`Warning: failed to parse __d(...) at offset ${start}: ${msg}`)
            i = start + '__d('.length
        }
    }

    return out
}

function findNextDCallStart(source: string, fromIdx: number): number {
    let mode: 'code' | 'single' | 'double' | 'template' | 'regex' | 'lineComment' | 'blockComment' =
        'code'
    let regexInClass = false
    let templateExprDepth = 0
    const templateExprStack: number[] = []

    for (let i = fromIdx; i < source.length; i++) {
        const ch = source[i]
        const next = i + 1 < source.length ? source[i + 1] : ''

        if (mode === 'lineComment') {
            if (ch === '\n') mode = 'code'
            continue
        }
        if (mode === 'blockComment') {
            if (ch === '*' && next === '/') {
                mode = 'code'
                i++
            }
            continue
        }
        if (mode === 'single') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === "'") mode = 'code'
            continue
        }
        if (mode === 'double') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === '"') mode = 'code'
            continue
        }
        if (mode === 'template') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === '`') {
                const prevDepth = templateExprStack.pop()
                templateExprDepth = prevDepth ?? 0
                mode = 'code'
                continue
            }
            if (ch === '$' && next === '{') {
                templateExprDepth = 1
                mode = 'code'
                i++
                continue
            }
            continue
        }
        if (mode === 'regex') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === '[') {
                regexInClass = true
                continue
            }
            if (ch === ']' && regexInClass) {
                regexInClass = false
                continue
            }
            if (ch === '/' && !regexInClass) {
                mode = 'code'
            }
            continue
        }

        if (ch === '/' && next === '/') {
            mode = 'lineComment'
            i++
            continue
        }
        if (ch === '/' && next === '*') {
            mode = 'blockComment'
            i++
            continue
        }
        if (ch === "'") {
            mode = 'single'
            continue
        }
        if (ch === '"') {
            mode = 'double'
            continue
        }
        if (ch === '`') {
            templateExprStack.push(templateExprDepth)
            templateExprDepth = 0
            mode = 'template'
            continue
        }
        if (ch === '/') {
            if (looksLikeRegexStart(source, i)) {
                mode = 'regex'
                regexInClass = false
                continue
            }
        }

        if (templateExprDepth > 0) {
            if (ch === '{') templateExprDepth++
            else if (ch === '}') {
                templateExprDepth--
                if (templateExprDepth === 0) {
                    mode = 'template'
                    continue
                }
            }
        }

        if (ch === '_' && source.startsWith('__d(', i)) {
            return i
        }
    }

    return -1
}

function findMatchingParen(source: string, openParenIdx: number): number {
    let depth = 0
    let mode: 'code' | 'single' | 'double' | 'template' | 'regex' | 'lineComment' | 'blockComment' =
        'code'
    let regexInClass = false
    let templateExprDepth = 0
    const templateExprStack: number[] = []

    for (let i = openParenIdx; i < source.length; i++) {
        const ch = source[i]
        const next = i + 1 < source.length ? source[i + 1] : ''

        if (mode === 'lineComment') {
            if (ch === '\n') mode = 'code'
            continue
        }
        if (mode === 'blockComment') {
            if (ch === '*' && next === '/') {
                mode = 'code'
                i++
            }
            continue
        }
        if (mode === 'single') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === "'") mode = 'code'
            continue
        }
        if (mode === 'double') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === '"') mode = 'code'
            continue
        }
        if (mode === 'template') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === '`') {
                const prevDepth = templateExprStack.pop()
                templateExprDepth = prevDepth ?? 0
                mode = 'code'
                continue
            }
            if (ch === '$' && next === '{') {
                templateExprDepth = 1
                mode = 'code'
                i++
                continue
            }
            continue
        }
        if (mode === 'regex') {
            if (ch === '\\') {
                i++
                continue
            }
            if (ch === '[') {
                regexInClass = true
                continue
            }
            if (ch === ']' && regexInClass) {
                regexInClass = false
                continue
            }
            if (ch === '/' && !regexInClass) {
                mode = 'code'
            }
            continue
        }

        if (ch === '/' && next === '/') {
            mode = 'lineComment'
            i++
            continue
        }
        if (ch === '/' && next === '*') {
            mode = 'blockComment'
            i++
            continue
        }
        if (ch === "'") {
            mode = 'single'
            continue
        }
        if (ch === '"') {
            mode = 'double'
            continue
        }
        if (ch === '`') {
            templateExprStack.push(templateExprDepth)
            templateExprDepth = 0
            mode = 'template'
            continue
        }
        if (ch === '/') {
            if (looksLikeRegexStart(source, i)) {
                mode = 'regex'
                regexInClass = false
                continue
            }
        }

        if (templateExprDepth > 0) {
            if (ch === '{') templateExprDepth++
            else if (ch === '}') {
                templateExprDepth--
                if (templateExprDepth === 0) {
                    mode = 'template'
                    continue
                }
            }
        }

        if (ch === '(') depth++
        else if (ch === ')') {
            depth--
            if (depth === 0) return i
        }
    }

    throw new Error('No matching closing parenthesis found for __d(')
}

function looksLikeRegexStart(source: string, slashIdx: number): boolean {
    const next = slashIdx + 1 < source.length ? source[slashIdx + 1] : ''
    if (next === '/' || next === '*') return false

    let j = slashIdx - 1
    while (j >= 0 && /\s/.test(source[j])) j--
    if (j < 0) return true

    const prev = source[j]

    if (/[\)\]\}]/.test(prev)) return false
    if (/[\w$]/.test(prev)) {
        let k = j
        while (k >= 0 && /[\w$]/.test(source[k])) k--
        const word = source.slice(k + 1, j + 1)
        if (word === 'return' || word === 'throw' || word === 'case') return true
        return false
    }
    if (prev === '.' || prev === '"' || prev === "'" || prev === '`') return false

    if (/[(\[\{,:;=!?~+\-*%&|^<>]/.test(prev)) return true

    return false
}

function extractFirstStringArg(dCall: string): string | null {
    const start = dCall.indexOf('__d(')
    if (start === -1) return null
    let i = start + '__d('.length
    while (i < dCall.length && /\s/.test(dCall[i])) i++
    const quote = dCall[i]
    if (quote !== '"' && quote !== "'") return null
    i++
    let out = ''
    for (; i < dCall.length; i++) {
        const ch = dCall[i]
        if (ch === '\\') {
            const next = i + 1 < dCall.length ? dCall[i + 1] : ''
            out += next
            i++
            continue
        }
        if (ch === quote) return out
        out += ch
    }
    return null
}

function printUsageAndExit() {
    console.error('Usage: wa-export <inputFile.js|inputFile.json> <outputDir?>')
    console.error(' - inputFile.js: bundle path')
    console.error(' - inputFile.json: JSON file with a string[] of URLs to .js bundles')
    console.error(' - outputDir (opcional): output dir')
    console.error(' - flags (only for .json input):')
    console.error(
        '   --no-subdirs | --flat : export all bundles into outputDir (no per-bundle subfolders)'
    )
    console.error(
        '   --concurrency N        : number of bundles to download/process in parallel (default: same as --workers, or 1)'
    )
    console.error(' - flags (any mode):')
    console.error(
        '   --to-ia               : minify output with terser and add line breaks for lower token usage'
    )
    console.error(
        '   --merge-common-names  : group exports into folders by common name prefixes (ignores WAWeb only for matching)'
    )
    console.error(
        '   --workers N           : number of worker threads for bundle processing (default: 0; supports --workers=N)'
    )
    console.error('   --help | -h           : show this help')
    console.error("   If not given, will be '<inputDir>/deobfuscated/<inputNameWithoutExt>'")
    process.exit(1)
}

function formatForIA(minified: string): string {
    return minified
        .replace(/;(?=\S)/g, ';\n')
        .replace(/\{(?=\S)/g, '{\n')
        .replace(/\}(?=[^\s,;)\]])/g, '}\n')
}

async function maybeToIA(code: string, enabled: boolean): Promise<string> {
    if (!enabled) return code
    try {
        const out = await minify(code, {
            compress: {
                dead_code: true,
                drop_console: false,
                drop_debugger: true,
                evaluate: true,
                booleans: true,
                conditionals: true,
                unused: true,
                sequences: false,
                join_vars: false,
                collapse_vars: false,
                reduce_vars: false,
                inline: false,
                loops: false,
                if_return: false
            },
            mangle: false,
            format: {
                comments: false,
                semicolons: true,
                beautify: false
            }
        })
        const min = out.code || ''
        if (!min) return formatForIA(code)
        return formatForIA(min)
    } catch {
        return formatForIA(code)
    }
}

export async function buildExportFiles(
    bundleContent: string,
    opts?: {
        disambiguate?: boolean
        toIa?: boolean
        mergeCommonNames?: boolean
        mergeCommonPrefixes?: string[] | null
    }
): Promise<ExportFile[]> {
    const calls = extractDCalls(bundleContent)

    if (calls.length === 0) {
        return []
    }

    const disambiguate = opts?.disambiguate !== false
    const toIa = opts?.toIa === true
    const mergeCommonNames = opts?.mergeCommonNames === true
    const mergeCommonPrefixes = opts?.mergeCommonPrefixes ?? null
    let count = 0
    const usedNames = disambiguate ? new Map<string, number>() : null
    const out: ExportFile[] = []

    let mergePrefixes: Array<{ raw: string; norm: string }> = []
    if (mergeCommonNames) {
        if (mergeCommonPrefixes && mergeCommonPrefixes.length > 0) {
            mergePrefixes = mergeCommonPrefixes.map((raw) => ({
                raw,
                norm: normalizeForMerge(raw)
            }))
        } else {
            const rawNamesForMerge: string[] = []
            for (const dCall of calls) {
                const rawName = (extractFirstStringArg(dCall) || '').trim()
                if (rawName && /^[\w\[\]-]+/.test(rawName)) {
                    rawNamesForMerge.push(rawName)
                }
            }
            mergePrefixes = computeMergePrefixes(rawNamesForMerge)
        }
    }

    for (const dCall of calls) {
        const rawName = (extractFirstStringArg(dCall) || '').trim()
        const safeBaseBase =
            rawName && /^[\w\[\]-]+/.test(rawName)
                ? rawName.replace(/[^\w\-\[\]]+/g, '_')
                : `module_${++count}`

        let safeBase = safeBaseBase
        if (usedNames) {
            const seen = usedNames.get(safeBaseBase) || 0
            usedNames.set(safeBaseBase, seen + 1)
            safeBase = seen === 0 ? safeBaseBase : `${safeBaseBase}_${seen + 1}`
        }
        const content = await maybeToIA(dCall, toIa)

        let relPath = `${safeBase}.js`
        if (mergeCommonNames && rawName && /^[\w\[\]-]+/.test(rawName)) {
            const dir = pickMergeDir(rawName, mergePrefixes)
            if (dir) {
                relPath = path.join(dir, `${safeBase}.js`)
            }
        }

        out.push({ fileName: relPath, content })
    }

    return out
}

async function writeExportFiles(outDir: string, files: ExportFile[]) {
    await fs.mkdir(outDir, { recursive: true })
    await runWithConcurrency(files, 20, async (f) => {
        const filePath = path.join(outDir, f.fileName)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, f.content, 'utf-8')
    })
}

function safeDirNameFromUrl(url: string, fallbackIndex: number): string {
    try {
        const u = new URL(url)
        const base = path.basename(u.pathname, path.extname(u.pathname))
        const cleaned = base.replace(/[^\w\-\[\]]+/g, '_').trim()

        const raw = cleaned || `bundle_${fallbackIndex}`
        const maxLen = 80
        if (raw.length <= maxLen) return raw

        const hash = createHash('sha1').update(raw).digest('hex').slice(0, 10)
        const prefixLen = Math.max(1, maxLen - (1 + hash.length))
        return `${raw.slice(0, prefixLen)}_${hash}`
    } catch {
        return `bundle_${fallbackIndex}`
    }
}

if (isMainThread) {
    const args = process.argv.slice(2)
    const positionals = args.filter((a) => !a.startsWith('-'))

    assertNoUnknownFlags(args)

    if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
        printUsageAndExit()
    }

    const inputArg = positionals[0]
    const outputArg = positionals[1]

    if (!inputArg) {
        printUsageAndExit()
    }

    const inputFile = path.resolve(process.cwd(), inputArg)
    const defaultOut = path.join(
        path.dirname(inputFile),
        'deobfuscated',
        path.basename(inputFile, path.extname(inputFile))
    )
    const outputDir = outputArg ? path.resolve(process.cwd(), outputArg) : defaultOut

    const suggested = Math.max(1, os.cpus().length - 1)
    const workersRaw = getArgValue(args, '--workers')
    const workersFlagPresent = hasFlag(args, '--workers')
    const workers = workersRaw === null ? (workersFlagPresent ? suggested : 0) : Number(workersRaw)
    if (!Number.isFinite(workers) || workers < 0) {
        throw new Error(`Invalid --workers value: ${String(workersRaw)}`)
    }

    const poolSize = Math.floor(workers)

    const pool = poolSize > 0 ? new WorkerPool(poolSize) : null

    const run = async () => {
        if (!(await fileExists(inputFile))) {
            console.error(`Input not found: ${inputFile}`)
            process.exit(1)
        }

        const ext = path.extname(inputFile).toLowerCase()

        if (ext === '.json') {
            const mergeCommonNames = hasFlag(args, '--merge-common-names')
            const flat = hasFlag(args, '--no-subdirs') || hasFlag(args, '--flat')
            const useUrlSubdirs = !mergeCommonNames && !flat
            const disambiguate = !flat
            const toIa = hasFlag(args, '--to-ia')
            const concRaw = getArgValue(args, '--concurrency')
            const defaultConcurrency = Math.max(1, poolSize > 0 ? poolSize : 1)
            const concurrency = concRaw ? Number(concRaw) : defaultConcurrency
            if (!Number.isFinite(concurrency) || concurrency <= 0) {
                throw new Error(`Invalid --concurrency value: ${String(concRaw)}`)
            }

            const raw = await fs.readFile(inputFile, 'utf-8')
            let urls: unknown
            try {
                urls = JSON.parse(raw)
            } catch (e: any) {
                throw new Error(`Invalid JSON in ${inputFile}: ${e?.message || String(e)}`)
            }

            if (!Array.isArray(urls) || !urls.every((x) => typeof x === 'string')) {
                throw new Error(`${inputFile} must contain a JSON string[] of URLs`)
            }

            await fs.mkdir(outputDir, { recursive: true })

            const usedDirs = new Map<string, number>()
            const jobs = (urls as string[]).map((url, idx) => {
                if (!useUrlSubdirs) {
                    return { url, outDir: outputDir }
                }
                const dirBase = safeDirNameFromUrl(url, idx + 1)
                const seen = usedDirs.get(dirBase) || 0
                usedDirs.set(dirBase, seen + 1)
                const dirName = seen === 0 ? dirBase : `${dirBase}_${seen + 1}`
                const outDir = path.join(outputDir, dirName)
                return { url, outDir }
            })

            if (!mergeCommonNames) {
                await runWithConcurrency(jobs, concurrency, async (job) => {
                    await fs.mkdir(job.outDir, { recursive: true })
                    const res = await fetch(job.url)
                    if (!res.ok) {
                        throw new Error(`Failed to fetch ${job.url}: HTTP ${res.status}`)
                    }

                    if (pool) {
                        const ab = await res.arrayBuffer()
                        await pool.process(
                            { buffer: ab, byteOffset: 0, byteLength: ab.byteLength },
                            job.outDir,
                            {
                                disambiguate,
                                toIa,
                                mergeCommonNames,
                                mergeCommonPrefixes: null
                            }
                        )
                        return
                    }

                    const content = await res.text()
                    const files = await buildExportFiles(content, {
                        disambiguate,
                        toIa,
                        mergeCommonNames,
                        mergeCommonPrefixes: null
                    })
                    if (files.length === 0) {
                        console.error('No module found (marker __d( not found).')
                        return
                    }
                    await writeExportFiles(job.outDir, files)
                })
            } else {
                const fetched: Array<{ outDir: string; ab: ArrayBuffer } | null> = new Array(
                    jobs.length
                ).fill(null)

                await runWithConcurrency(jobs, concurrency, async (job, idx) => {
                    const res = await fetch(job.url)
                    if (!res.ok) {
                        throw new Error(`Failed to fetch ${job.url}: HTTP ${res.status}`)
                    }
                    const ab = await res.arrayBuffer()
                    fetched[idx] = { outDir: job.outDir, ab }
                })

                const allRawNames: string[] = []
                for (const item of fetched) {
                    if (!item) continue
                    const text = Buffer.from(item.ab).toString('utf-8')
                    const calls = extractDCalls(text)
                    for (const dCall of calls) {
                        const rawName = (extractFirstStringArg(dCall) || '').trim()
                        if (rawName && /^[\w\[\]-]+/.test(rawName)) {
                            allRawNames.push(rawName)
                        }
                    }
                }

                const globalPrefixes = computeMergePrefixes(allRawNames).map((p) => p.raw)

                await runWithConcurrency(
                    fetched.map((x, idx) => ({ idx, item: x })),
                    concurrency,
                    async ({ item }) => {
                        if (!item) return
                        await fs.mkdir(item.outDir, { recursive: true })

                        if (pool) {
                            await pool.process(
                                { buffer: item.ab, byteOffset: 0, byteLength: item.ab.byteLength },
                                item.outDir,
                                {
                                    disambiguate,
                                    toIa,
                                    mergeCommonNames,
                                    mergeCommonPrefixes: globalPrefixes
                                }
                            )
                            return
                        }

                        const text = Buffer.from(item.ab).toString('utf-8')
                        const files = await buildExportFiles(text, {
                            disambiguate,
                            toIa,
                            mergeCommonNames,
                            mergeCommonPrefixes: globalPrefixes
                        })
                        if (files.length === 0) {
                            console.error('No module found (marker __d( not found).')
                            return
                        }
                        await writeExportFiles(item.outDir, files)
                    }
                )
            }

            console.log(`Export finished. Files saved in: ${outputDir}`)
            return
        }

        if (ext !== '.js') {
            throw new Error(`Unsupported input extension: ${ext}. Use .js or .json`)
        }

        await fs.mkdir(outputDir, { recursive: true })
        const toIa = hasFlag(args, '--to-ia')
        const mergeCommonNames = hasFlag(args, '--merge-common-names')

        if (pool) {
            const buf = await fs.readFile(inputFile)
            const canTransferZeroCopy =
                buf.byteOffset === 0 && buf.byteLength === (buf.buffer as ArrayBuffer).byteLength
            const ab = canTransferZeroCopy
                ? (buf.buffer as ArrayBuffer)
                : new Uint8Array(buf).slice().buffer
            await pool.process(
                {
                    buffer: ab,
                    byteOffset: 0,
                    byteLength: buf.byteLength
                },
                outputDir,
                {
                    disambiguate: true,
                    toIa,
                    mergeCommonNames,
                    mergeCommonPrefixes: null
                }
            )
            console.log(`Export finished. Files saved in: ${outputDir}`)
            return
        }

        const fileContent = await fs.readFile(inputFile, 'utf-8')
        const files = await buildExportFiles(fileContent, {
            toIa,
            mergeCommonNames,
            mergeCommonPrefixes: null
        })
        if (files.length === 0) {
            console.error('No module found (marker __d( not found).')
            return
        }
        await writeExportFiles(outputDir, files)
        console.log(`Export finished. Files saved in: ${outputDir}`)
    }

    run()
        .catch((e) => {
            console.error(e)
            process.exit(1)
        })
        .finally(async () => {
            if (pool) await pool.destroy()
        })
}
