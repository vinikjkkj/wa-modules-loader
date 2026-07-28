#!/usr/bin/env node
import { createHash, randomBytes } from 'crypto'
import { createWriteStream, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { minify } from 'terser'
import { Worker, isMainThread } from 'worker_threads'

import { ZipReader, type ZipEntry } from './zip'

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

function getArgValues(args: string[], flagName: string): string[] {
    const values: string[] = []
    const prefix = `${flagName}=`

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === flagName) {
            const val = i + 1 < args.length ? args[i + 1] : null
            if (!val || val.startsWith('-')) {
                throw new Error(`Missing value for ${flagName}`)
            }
            values.push(val)
            i++
            continue
        }

        if (arg.startsWith(prefix)) {
            const val = arg.slice(prefix.length)
            if (!val) {
                throw new Error(`Missing value for ${flagName}`)
            }
            values.push(val)
        }
    }

    return values
}

function getPositionals(args: string[]): string[] {
    const flagsWithValue = new Set([
        '--concurrency',
        '--workers',
        '--module-filter',
        '--direct-url'
    ])
    const positionals: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg.startsWith('-')) {
            const base = arg.startsWith('--') ? arg.split('=')[0] : arg
            if (flagsWithValue.has(base) && arg === base) {
                const next = i + 1 < args.length ? args[i + 1] : null
                if (next && !next.startsWith('-')) i++
            }
            continue
        }
        positionals.push(arg)
    }

    return positionals
}

function parseModuleNameFilterPatterns(args: string[]): string[] {
    return normalizeModuleNameFilterPatterns(getArgValues(args, '--module-filter'))
}

function normalizeModuleNameFilterPatterns(filters: string[] | undefined): string[] {
    const cleaned = (filters || []).map((v) => v.trim()).filter(Boolean)

    return [...new Set(cleaned)]
}

function compileFilterRegex(pattern: string): RegExp {
    if (!pattern.startsWith('/')) {
        return new RegExp(pattern, 'i')
    }

    let lastSlash = -1
    for (let i = pattern.length - 1; i > 0; i--) {
        if (pattern[i] !== '/') continue
        let backslashes = 0
        for (let j = i - 1; j >= 0 && pattern[j] === '\\'; j--) backslashes++
        if (backslashes % 2 === 0) {
            lastSlash = i
            break
        }
    }

    if (lastSlash <= 0) {
        return new RegExp(pattern, 'i')
    }

    const body = pattern.slice(1, lastSlash)
    const flags = pattern.slice(lastSlash + 1)
    return new RegExp(body, flags)
}

function compileModuleNameFilters(rawFilters: string[]): RegExp[] {
    return rawFilters.map((raw) => {
        try {
            return compileFilterRegex(raw)
        } catch (e: any) {
            const msg = e && typeof e.message === 'string' ? e.message : String(e)
            throw new Error(`Invalid --module-filter regex '${raw}': ${msg}`)
        }
    })
}

function moduleNameMatchesFilters(rawName: string, filters: RegExp[]): boolean {
    if (filters.length === 0) return true
    if (!rawName) return false
    return filters.some((filter) => {
        filter.lastIndex = 0
        return filter.test(rawName)
    })
}

function noModulesMessage(filters: RegExp[]): string {
    if (filters.length === 0) {
        return 'No module found (marker __d( not found).'
    }
    return 'No module found (marker __d( not found or no module matched --module-filter).'
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

/** First index whose value is >= target, in a lexicographically sorted array. */
function lowerBound(sorted: string[], target: string): number {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (sorted[mid] < target) lo = mid + 1
        else hi = mid
    }
    return lo
}

/** End (exclusive) of the run of values starting with prefix, which begins at from. */
function prefixEnd(sorted: string[], prefix: string, from: number): number {
    let lo = from
    let hi = sorted.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (sorted[mid].startsWith(prefix)) lo = mid + 1
        else hi = mid
    }
    return lo
}

function computeMergePrefixes(
    rawNames: string[],
    minPrefixLen = 3,
    minMembers = 2
): Array<{ raw: string; norm: string; isSuffix?: boolean }> {
    if (rawNames.length < minMembers) return []

    // Members are tracked per raw name, so repeats add nothing but cost. A
    // release archive repeats the same module across thousands of chunks.
    const items = [...new Set(rawNames)]
        .map((raw) => ({ raw, norm: normalizeForMerge(raw) }))
        .filter((x) => x.norm.length >= minPrefixLen)

    // Code point order, not locale order: the scan below relies on every name
    // sharing a given prefix forming one contiguous run.
    items.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0))

    const norms = items.map((x) => x.norm)

    // In a sorted array the common prefix of any pair is the shortest common
    // prefix of the adjacent pairs between them, so every prefix that could
    // ever group two names already shows up as an adjacent common prefix. That
    // turns the pair scan into a single walk, and each prefix's members into a
    // binary-searched range instead of a set built pair by pair.
    const prefixRanges = new Map<string, { lo: number; hi: number }>()

    for (let k = 0; k + 1 < norms.length; k++) {
        const lcp = longestCommonPrefix(norms[k], norms[k + 1])
        if (lcp.length < minPrefixLen || prefixRanges.has(lcp)) continue
        const lo = lowerBound(norms, lcp)
        prefixRanges.set(lcp, { lo, hi: prefixEnd(norms, lcp, lo) })
    }

    const suffixMembers = new Map<string, Set<string>>()
    for (const { raw, norm } of items) {
        const dotIdx = norm.lastIndexOf('.')
        if (dotIdx > 0) {
            const suffix = norm.slice(dotIdx + 1)
            if (suffix.length >= 2) {
                if (!suffixMembers.has(suffix)) suffixMembers.set(suffix, new Set())
                suffixMembers.get(suffix)!.add(raw)
            }
        }
    }

    const selected: Array<{ norm: string; isSuffix: boolean; lo: number; hi: number }> = []
    const covered = new Set<string>()

    const suffixCandidates = [...suffixMembers.entries()]
        .filter(([_, members]) => members.size >= minMembers)
        .sort((a, b) => b[1].size - a[1].size)

    for (const [suffix, members] of suffixCandidates) {
        const uncovered = [...members].filter((m) => !covered.has(m))
        if (uncovered.length >= minMembers) {
            selected.push({ norm: suffix, isSuffix: true, lo: 0, hi: 0 })
            for (const m of members) covered.add(m)
        }
    }

    const prefixCandidates = [...prefixRanges.entries()]
        .filter(([_, range]) => range.hi - range.lo >= minMembers)
        .sort((a, b) => b[0].length - a[0].length || b[1].hi - b[1].lo - (a[1].hi - a[1].lo))

    for (const [prefix, range] of prefixCandidates) {
        let uncovered = 0
        for (let i = range.lo; i < range.hi; i++) {
            if (!covered.has(items[i].raw)) uncovered++
        }
        if (uncovered >= minMembers) {
            selected.push({ norm: prefix, isSuffix: false, lo: range.lo, hi: range.hi })
            for (let i = range.lo; i < range.hi; i++) covered.add(items[i].raw)
        }
    }

    return selected.map(({ norm, isSuffix, lo, hi }) => {
        if (isSuffix) {
            return { raw: norm, norm, isSuffix: true }
        }
        let withWAWeb = 0
        for (let i = lo; i < hi; i++) {
            if (items[i].raw.startsWith('WAWeb')) withWAWeb++
        }
        const raw = withWAWeb > (hi - lo) / 2 ? `WAWeb${norm}` : norm
        return { raw, norm }
    })
}

function pickMergeDir(
    rawName: string,
    prefixes: Array<{ raw: string; norm: string; isSuffix?: boolean }>
): string | null {
    const norm = normalizeForMerge(rawName)

    const dotIdx = norm.lastIndexOf('.')
    if (dotIdx > 0) {
        const suffix = norm.slice(dotIdx + 1)
        for (const p of prefixes) {
            if (p.isSuffix && suffix === p.norm) {
                return safeNameComponent(p.raw)
            }
        }
    }

    let bestPrefix: { raw: string; norm: string } | null = null
    for (const p of prefixes) {
        if (!p.isSuffix && norm.startsWith(p.norm)) {
            if (!bestPrefix || p.norm.length > bestPrefix.norm.length) bestPrefix = p
        }
    }
    if (bestPrefix) return safeNameComponent(bestPrefix.raw)

    return null
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
        '--module-filter',
        '--direct-url',
        '--no-dedupe-modules',
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

export type ExportModulesOptions = {
    inputFile?: string
    directUrl?: string
    outputDir?: string
    toIa?: boolean
    mergeCommonNames?: boolean
    workers?: number
    concurrency?: number
    flat?: boolean
    noSubdirs?: boolean
    moduleNameFilters?: string[]
    dedupeModules?: boolean
    onProgress?: (done: number, total: number, phase: ExportPhase) => void
}

/**
 * 'scan' collects module names ahead of time, which both --merge-common-names
 * (to pick the folder layout) and archive dedupe need. 'group' is the
 * single-shot step that turns those names into prefixes.
 */
export type ExportPhase = 'scan' | 'group' | 'export'

export type ExportModulesResult = {
    inputFile: string
    outputDir: string
    mode: 'js' | 'json' | 'url' | 'archive'
    bundlesProcessed: number
    filesWritten: number
    skippedBundles: number
    /** Archive entries whose modules were all already owned by an earlier entry. */
    duplicateBundlesSkipped?: number
}

type WorkerRequest = {
    id: number
    bundle: ArrayBuffer
    byteOffset: number
    byteLength: number
    disambiguate: boolean
    toIa: boolean
    mergeCommonNames: boolean
    mergeCommonPrefixes: Array<{ raw: string; isSuffix?: boolean }> | null
    moduleNameFilters: string[]
    ownedModuleNames: string[] | null
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
    fileCount: number
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
            fileCount: number
            resolve: (filesWritten: number) => void
            reject: (e: Error) => void
        }
    >()

    constructor(count: number) {
        const workerPath = path.join(__dirname, 'worker.js')
        this.workers = new Array(count).fill(0).map(() => {
            const w = new Worker(workerPath)
            w.on('message', (msg: WorkerChunk | WorkerDone | WorkerError) => this.onMessage(msg))
            w.on('error', (e: Error) => this.onWorkerError(e))
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
            t.fileCount += msg.files.length
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
                t.fileCount = msg.fileCount
                t.resolve(t.fileCount)
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
            mergeCommonPrefixes: Array<{ raw: string; isSuffix?: boolean }> | null
            moduleNameFilters: string[]
            ownedModuleNames?: string[] | null
        }
    ): Promise<number> {
        const id = this.nextTaskId++

        const p = new Promise<number>((resolve, reject) => {
            this.tasks.set(id, {
                outDir,
                writeChain: Promise.resolve(),
                fileCount: 0,
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
            mergeCommonPrefixes: opts.mergeCommonPrefixes,
            moduleNameFilters: opts.moduleNameFilters,
            ownedModuleNames: opts.ownedModuleNames ?? null
        }

        const w = this.workers[this.nextWorkerIdx]
        this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length
        w.postMessage(req, [bundle.buffer])
        return await p
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
    console.error('       wa-export --direct-url <URL> <outputDir?>')
    console.error(' - inputFile.js: bundle path')
    console.error(' - inputFile.json: JSON file with a string[] of URLs to .js bundles')
    console.error(' - outputDir (opcional): output dir')
    console.error(' - flags (only for --direct-url):')
    console.error(
        '   --direct-url URL      : download and export a .js bundle or a release .zip archive;'
    )
    console.error(
        '                           non-.js archive entries are dropped and output is always flat'
    )
    console.error(
        '   --no-dedupe-modules   : export every copy of a module instead of only the first'
    )
    console.error(
        '                           archive entry that carries it (slower, same files on disk)'
    )
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
    console.error(
        '   --module-filter REGEXP: export only modules whose names match REGEXP (repeatable)'
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
        mergeCommonPrefixes?: Array<{ raw: string; isSuffix?: boolean }> | null
        moduleNameFilters?: string[]
        /**
         * Names this bundle is responsible for. Modules named anything else are
         * dropped before minification, which is how a release archive avoids
         * re-exporting the same module once per chunk that happens to embed it.
         * Unnamed modules are always kept, since they cannot be attributed.
         */
        ownedModuleNames?: string[] | null
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
    const moduleNameFilters = compileModuleNameFilters(opts?.moduleNameFilters ?? [])
    const filteredCalls =
        moduleNameFilters.length === 0
            ? calls.map((dCall) => ({
                  dCall,
                  rawName: (extractFirstStringArg(dCall) || '').trim()
              }))
            : calls
                  .map((dCall) => ({
                      dCall,
                      rawName: (extractFirstStringArg(dCall) || '').trim()
                  }))
                  .filter((entry) => moduleNameMatchesFilters(entry.rawName, moduleNameFilters))

    const owned = opts?.ownedModuleNames ? new Set(opts.ownedModuleNames) : null
    const ownedCalls = owned
        ? filteredCalls.filter((entry) => !entry.rawName || owned.has(entry.rawName))
        : filteredCalls

    if (ownedCalls.length === 0) {
        return []
    }

    let count = 0
    const usedNames = disambiguate ? new Map<string, number>() : null
    const out: ExportFile[] = []

    let mergePrefixes: Array<{ raw: string; norm: string; isSuffix?: boolean }> = []
    if (mergeCommonNames) {
        if (mergeCommonPrefixes && mergeCommonPrefixes.length > 0) {
            mergePrefixes = mergeCommonPrefixes.map((p) => ({
                raw: p.raw,
                norm: normalizeForMerge(p.raw),
                isSuffix: p.isSuffix
            }))
        } else {
            const rawNamesForMerge: string[] = []
            for (const { rawName } of ownedCalls) {
                if (rawName && /^[\w\[\]-]+/.test(rawName)) {
                    rawNamesForMerge.push(rawName)
                }
            }
            mergePrefixes = computeMergePrefixes(rawNamesForMerge)
        }
    }

    for (const { dCall, rawName } of ownedCalls) {
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

function defaultOutputDirForInput(inputFile: string): string {
    return path.join(
        path.dirname(inputFile),
        'deobfuscated',
        path.basename(inputFile, path.extname(inputFile))
    )
}

function defaultOutputDirForUrl(url: string): string {
    let name = ''
    try {
        const u = new URL(url)
        const segments = u.pathname.split('/').filter(Boolean)
        const tail = segments.slice(-2).join('_')
        name = safeNameComponent(path.basename(tail, path.extname(tail)))
    } catch {
        name = ''
    }
    return path.join(process.cwd(), 'deobfuscated', name || 'download')
}

// Release endpoints tend to answer 400 to a bare fetch; they only serve the
// payload to something that looks like a real browser navigation.
const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="126", "Not:A-Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1'
}

async function downloadToFile(url: string, destFile: string): Promise<void> {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' })
    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`)
    }
    if (!res.body) {
        throw new Error(`Empty response body for ${url}`)
    }
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destFile))
}

async function isZipFile(filePath: string): Promise<boolean> {
    const handle = await fs.open(filePath, 'r')
    try {
        const buf = Buffer.alloc(4)
        const { bytesRead } = await handle.read(buf, 0, 4, 0)
        return bytesRead === 4 && buf.readUInt32LE(0) === 0x04034b50
    } finally {
        await handle.close()
    }
}

function isJsEntry(entry: ZipEntry): boolean {
    return !entry.fileName.endsWith('/') && path.extname(entry.fileName).toLowerCase() === '.js'
}

/**
 * Buffers smaller than the Buffer pool size share a single backing ArrayBuffer,
 * so they must be copied before being transferred to a worker.
 */
function toTransferable(buf: Buffer): {
    buffer: ArrayBuffer
    byteOffset: number
    byteLength: number
} {
    const canTransferZeroCopy =
        buf.byteOffset === 0 && buf.byteLength === (buf.buffer as ArrayBuffer).byteLength
    const ab = canTransferZeroCopy
        ? (buf.buffer as ArrayBuffer)
        : new Uint8Array(buf).slice().buffer
    return { buffer: ab, byteOffset: 0, byteLength: buf.byteLength }
}

async function exportFromDirectUrl(
    url: string,
    options: ExportModulesOptions
): Promise<ExportModulesResult> {
    try {
        new URL(url)
    } catch {
        throw new Error(`Invalid --direct-url value: ${url}`)
    }

    const outputDir = options.outputDir
        ? path.resolve(process.cwd(), options.outputDir)
        : defaultOutputDirForUrl(url)

    const workersRaw = options.workers ?? 0
    if (!Number.isFinite(workersRaw) || workersRaw < 0) {
        throw new Error(`Invalid workers value: ${String(workersRaw)}`)
    }
    const poolSize = Math.floor(workersRaw)

    const moduleNameFilterPatterns = normalizeModuleNameFilterPatterns(options.moduleNameFilters)
    const moduleNameFilters = compileModuleNameFilters(moduleNameFilterPatterns)
    const toIa = options.toIa === true
    const mergeCommonNames = options.mergeCommonNames === true
    const dedupeModules = options.dedupeModules !== false

    const defaultConcurrency = Math.max(4, poolSize)
    const concurrencyRaw = options.concurrency
    const concurrency = concurrencyRaw === undefined ? defaultConcurrency : Number(concurrencyRaw)
    if (!Number.isFinite(concurrency) || concurrency <= 0) {
        throw new Error(`Invalid concurrency value: ${String(concurrencyRaw)}`)
    }

    const tmpFile = path.join(
        os.tmpdir(),
        `wa-export-${process.pid}-${randomBytes(6).toString('hex')}.bin`
    )

    let filesWritten = 0
    let skippedBundles = 0
    let bundlesProcessed = 0
    let duplicateBundlesSkipped = 0

    await fs.mkdir(outputDir, { recursive: true })
    await downloadToFile(url, tmpFile)

    const pool = poolSize > 0 ? new WorkerPool(poolSize) : null

    try {
        if (!(await isZipFile(tmpFile))) {
            bundlesProcessed = 1
            const buf = await fs.readFile(tmpFile)

            if (pool) {
                const written = await pool.process(toTransferable(buf), outputDir, {
                    disambiguate: true,
                    toIa,
                    mergeCommonNames,
                    mergeCommonPrefixes: null,
                    moduleNameFilters: moduleNameFilterPatterns
                })
                if (written === 0) skippedBundles = 1
                else filesWritten = written
            } else {
                const files = await buildExportFiles(buf.toString('utf-8'), {
                    toIa,
                    mergeCommonNames,
                    mergeCommonPrefixes: null,
                    moduleNameFilters: moduleNameFilterPatterns
                })
                if (files.length === 0) {
                    skippedBundles = 1
                } else {
                    await writeExportFiles(outputDir, files)
                    filesWritten = files.length
                }
            }

            return {
                inputFile: url,
                outputDir,
                mode: 'url',
                bundlesProcessed,
                filesWritten,
                skippedBundles
            }
        }

        const reader = await ZipReader.open(tmpFile)

        try {
            // The release archive also ships .css (and whatever else); only .js
            // can hold Metro modules, so everything else is dropped up front.
            const jsEntries = reader.entries.filter(isJsEntry)
            bundlesProcessed = jsEntries.length

            let globalPrefixes: Array<{ raw: string; isSuffix?: boolean }> | null = null
            let ownedByEntry: Array<string[]> | null = null
            let entryHasUnnamed: boolean[] | null = null

            if (mergeCommonNames || dedupeModules) {
                // Grouping needs every module name up front to decide the folder
                // layout, and dedupe needs to know which entry owns each name.
                // The archive does not fit in memory, so names are collected in a
                // first pass and the payloads are re-read afterwards.
                const owner = new Map<string, number>()
                const unnamed = new Array<boolean>(jsEntries.length).fill(false)
                let scanned = 0

                await runWithConcurrency(jsEntries, concurrency, async (entry, index) => {
                    const buf = await reader.read(entry)
                    for (const dCall of extractDCalls(buf.toString('utf-8'))) {
                        const rawName = (extractFirstStringArg(dCall) || '').trim()
                        if (!rawName) {
                            unnamed[index] = true
                            continue
                        }
                        if (!moduleNameMatchesFilters(rawName, moduleNameFilters)) continue
                        // First entry to carry a name keeps it; the copies in
                        // every other chunk are redundant work.
                        if (!owner.has(rawName)) owner.set(rawName, index)
                    }
                    options.onProgress?.(++scanned, jsEntries.length, 'scan')
                })

                if (dedupeModules) {
                    ownedByEntry = jsEntries.map(() => [])
                    for (const [name, index] of owner) ownedByEntry[index].push(name)
                    entryHasUnnamed = unnamed
                }

                if (mergeCommonNames) {
                    const mergeNames = [...owner.keys()].filter((n) => /^[\w\[\]-]+/.test(n))
                    options.onProgress?.(0, mergeNames.length, 'group')
                    globalPrefixes = computeMergePrefixes(mergeNames).map((p) => ({
                        raw: p.raw,
                        isSuffix: p.isSuffix
                    }))
                    options.onProgress?.(mergeNames.length, mergeNames.length, 'group')
                }
            }

            let processed = 0
            await runWithConcurrency(jsEntries, concurrency, async (entry, index) => {
                const owned = ownedByEntry ? ownedByEntry[index] : null

                // Nothing to export and nothing unattributable to keep: the
                // entry can be skipped without even inflating it.
                if (owned && owned.length === 0 && !entryHasUnnamed?.[index]) {
                    duplicateBundlesSkipped++
                    options.onProgress?.(++processed, jsEntries.length, 'export')
                    return
                }

                const buf = await reader.read(entry)

                if (pool) {
                    const written = await pool.process(toTransferable(buf), outputDir, {
                        disambiguate: true,
                        toIa,
                        mergeCommonNames,
                        mergeCommonPrefixes: globalPrefixes,
                        moduleNameFilters: moduleNameFilterPatterns,
                        ownedModuleNames: owned
                    })
                    if (written === 0) skippedBundles++
                    else filesWritten += written
                } else {
                    const files = await buildExportFiles(buf.toString('utf-8'), {
                        disambiguate: true,
                        toIa,
                        mergeCommonNames,
                        mergeCommonPrefixes: globalPrefixes,
                        moduleNameFilters: moduleNameFilterPatterns,
                        ownedModuleNames: owned
                    })
                    if (files.length === 0) {
                        skippedBundles++
                    } else {
                        await writeExportFiles(outputDir, files)
                        filesWritten += files.length
                    }
                }

                options.onProgress?.(++processed, jsEntries.length, 'export')
            })
        } finally {
            await reader.close()
        }

        return {
            inputFile: url,
            outputDir,
            mode: 'archive',
            bundlesProcessed,
            filesWritten,
            skippedBundles,
            duplicateBundlesSkipped
        }
    } finally {
        if (pool) await pool.destroy()
        await fs.rm(tmpFile, { force: true })
    }
}

export async function exportModules(options: ExportModulesOptions): Promise<ExportModulesResult> {
    if (options.directUrl) {
        if (options.inputFile) {
            throw new Error('Use either inputFile or directUrl, not both')
        }
        return await exportFromDirectUrl(options.directUrl, options)
    }

    if (!options.inputFile) {
        throw new Error('Missing inputFile (or directUrl)')
    }

    const inputFile = path.resolve(process.cwd(), options.inputFile)
    const outputDir = options.outputDir
        ? path.resolve(process.cwd(), options.outputDir)
        : defaultOutputDirForInput(inputFile)

    if (!(await fileExists(inputFile))) {
        throw new Error(`Input não encontrado: ${inputFile}`)
    }

    const ext = path.extname(inputFile).toLowerCase()
    if (ext !== '.js' && ext !== '.json') {
        throw new Error(`Unsupported input extension: ${ext}. Use .js or .json`)
    }

    const workersRaw = options.workers ?? 0
    if (!Number.isFinite(workersRaw) || workersRaw < 0) {
        throw new Error(`Invalid workers value: ${String(workersRaw)}`)
    }
    const poolSize = Math.floor(workersRaw)

    const moduleNameFilterPatterns = normalizeModuleNameFilterPatterns(options.moduleNameFilters)
    const moduleNameFilters = compileModuleNameFilters(moduleNameFilterPatterns)

    let filesWritten = 0
    let skippedBundles = 0
    let bundlesProcessed = 0
    const mode: ExportModulesResult['mode'] = ext === '.json' ? 'json' : 'js'

    const pool = poolSize > 0 ? new WorkerPool(poolSize) : null

    try {
        if (ext === '.json') {
            const mergeCommonNames = options.mergeCommonNames === true
            const flat = options.flat === true || options.noSubdirs === true
            const useUrlSubdirs = !mergeCommonNames && !flat
            const disambiguate = !flat
            const toIa = options.toIa === true
            const defaultConcurrency = Math.max(1, poolSize > 0 ? poolSize : 1)
            const concurrencyRaw = options.concurrency
            const concurrency =
                concurrencyRaw === undefined ? defaultConcurrency : Number(concurrencyRaw)
            if (!Number.isFinite(concurrency) || concurrency <= 0) {
                throw new Error(`Invalid concurrency value: ${String(concurrencyRaw)}`)
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
            bundlesProcessed = urls.length

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
                        const written = await pool.process(
                            { buffer: ab, byteOffset: 0, byteLength: ab.byteLength },
                            job.outDir,
                            {
                                disambiguate,
                                toIa,
                                mergeCommonNames,
                                mergeCommonPrefixes: null,
                                moduleNameFilters: moduleNameFilterPatterns
                            }
                        )
                        if (written === 0) {
                            skippedBundles++
                            return
                        }
                        filesWritten += written
                        return
                    }

                    const content = await res.text()
                    const files = await buildExportFiles(content, {
                        disambiguate,
                        toIa,
                        mergeCommonNames,
                        mergeCommonPrefixes: null,
                        moduleNameFilters: moduleNameFilterPatterns
                    })
                    if (files.length === 0) {
                        skippedBundles++
                        return
                    }
                    await writeExportFiles(job.outDir, files)
                    filesWritten += files.length
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
                        if (
                            rawName &&
                            /^[\w\[\]-]+/.test(rawName) &&
                            moduleNameMatchesFilters(rawName, moduleNameFilters)
                        ) {
                            allRawNames.push(rawName)
                        }
                    }
                }

                const globalPrefixes = computeMergePrefixes(allRawNames).map((p) => ({
                    raw: p.raw,
                    isSuffix: p.isSuffix
                }))

                await runWithConcurrency(
                    fetched.map((item) => ({ item })),
                    concurrency,
                    async ({ item }) => {
                        if (!item) return
                        await fs.mkdir(item.outDir, { recursive: true })

                        if (pool) {
                            const written = await pool.process(
                                { buffer: item.ab, byteOffset: 0, byteLength: item.ab.byteLength },
                                item.outDir,
                                {
                                    disambiguate,
                                    toIa,
                                    mergeCommonNames,
                                    mergeCommonPrefixes: globalPrefixes,
                                    moduleNameFilters: moduleNameFilterPatterns
                                }
                            )
                            if (written === 0) {
                                skippedBundles++
                                return
                            }
                            filesWritten += written
                            return
                        }

                        const text = Buffer.from(item.ab).toString('utf-8')
                        const files = await buildExportFiles(text, {
                            disambiguate,
                            toIa,
                            mergeCommonNames,
                            mergeCommonPrefixes: globalPrefixes,
                            moduleNameFilters: moduleNameFilterPatterns
                        })
                        if (files.length === 0) {
                            skippedBundles++
                            return
                        }
                        await writeExportFiles(item.outDir, files)
                        filesWritten += files.length
                    }
                )
            }

            return {
                inputFile,
                outputDir,
                mode,
                bundlesProcessed,
                filesWritten,
                skippedBundles
            }
        }

        await fs.mkdir(outputDir, { recursive: true })
        bundlesProcessed = 1
        const toIa = options.toIa === true
        const mergeCommonNames = options.mergeCommonNames === true

        if (pool) {
            const buf = await fs.readFile(inputFile)
            const written = await pool.process(toTransferable(buf), outputDir, {
                disambiguate: true,
                toIa,
                mergeCommonNames,
                mergeCommonPrefixes: null,
                moduleNameFilters: moduleNameFilterPatterns
            })
            if (written === 0) {
                skippedBundles = 1
            } else {
                filesWritten = written
            }

            return {
                inputFile,
                outputDir,
                mode,
                bundlesProcessed,
                filesWritten,
                skippedBundles
            }
        }

        const fileContent = await fs.readFile(inputFile, 'utf-8')
        const files = await buildExportFiles(fileContent, {
            toIa,
            mergeCommonNames,
            mergeCommonPrefixes: null,
            moduleNameFilters: moduleNameFilterPatterns
        })
        if (files.length === 0) {
            skippedBundles = 1
            return {
                inputFile,
                outputDir,
                mode,
                bundlesProcessed,
                filesWritten,
                skippedBundles
            }
        }
        await writeExportFiles(outputDir, files)
        filesWritten = files.length
        return {
            inputFile,
            outputDir,
            mode,
            bundlesProcessed,
            filesWritten,
            skippedBundles
        }
    } finally {
        if (pool) await pool.destroy()
    }
}

if (isMainThread && require.main === module) {
    const args = process.argv.slice(2)
    const positionals = getPositionals(args)

    assertNoUnknownFlags(args)

    if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
        printUsageAndExit()
    }

    const directUrl = getArgValue(args, '--direct-url')
    if (hasFlag(args, '--direct-url') && !directUrl) {
        throw new Error('Missing value for --direct-url')
    }

    // With --direct-url there is no input positional, so the first positional
    // is the output dir.
    if (directUrl && positionals.length > 1) {
        throw new Error(
            `--direct-url takes no input file, only an optional output dir (got: ${positionals.join(', ')})`
        )
    }
    const inputArg = directUrl ? undefined : positionals[0]
    const outputArg = directUrl ? positionals[0] : positionals[1]

    if (!inputArg && !directUrl) {
        printUsageAndExit()
    }

    const moduleNameFilterPatterns = parseModuleNameFilterPatterns(args)
    const emptyResultMessage = noModulesMessage(compileModuleNameFilters(moduleNameFilterPatterns))
    const suggestedWorkers = Math.max(1, os.cpus().length - 1)
    const workersRaw = getArgValue(args, '--workers')
    const workersFlagPresent = hasFlag(args, '--workers')
    const workers =
        workersRaw === null ? (workersFlagPresent ? suggestedWorkers : 0) : Number(workersRaw)
    if (!Number.isFinite(workers) || workers < 0) {
        throw new Error(`Invalid --workers value: ${String(workersRaw)}`)
    }
    const concRaw = getArgValue(args, '--concurrency')
    const concurrency = concRaw ? Number(concRaw) : undefined
    if (concRaw !== null && (!Number.isFinite(concurrency) || (concurrency as number) <= 0)) {
        throw new Error(`Invalid --concurrency value: ${String(concRaw)}`)
    }

    const progressLabels: Record<ExportPhase, string> = {
        scan: 'Scanning module names',
        group: 'Grouping module names',
        export: 'Exporting'
    }
    let lastProgressPhase: ExportPhase | null = null
    let lastProgressAt = 0
    const onProgress = (done: number, total: number, phase: ExportPhase) => {
        // Each phase counts from zero again, so the throttle has to reset with
        // it -- otherwise every phase after the first stays silent until it ends
        // and the run looks hung.
        if (phase !== lastProgressPhase) {
            lastProgressPhase = phase
            lastProgressAt = 0
        } else if (done !== total && done - lastProgressAt < 500) {
            return
        }
        lastProgressAt = done
        const unit = phase === 'group' ? 'names' : 'bundles'
        console.error(`${progressLabels[phase]}: ${done}/${total} ${unit}...`)
    }

    const run = async () => {
        const result = await exportModules({
            inputFile: inputArg,
            directUrl: directUrl ?? undefined,
            onProgress,
            outputDir: outputArg,
            toIa: hasFlag(args, '--to-ia'),
            mergeCommonNames: hasFlag(args, '--merge-common-names'),
            workers,
            concurrency,
            flat: hasFlag(args, '--flat'),
            noSubdirs: hasFlag(args, '--no-subdirs'),
            moduleNameFilters: moduleNameFilterPatterns,
            dedupeModules: !hasFlag(args, '--no-dedupe-modules')
        })
        if (result.filesWritten === 0) {
            console.error(emptyResultMessage)
        }
        console.log(`Export finished. Files saved in: ${result.outputDir}`)
    }

    run().catch((e) => {
        console.error(e)
        process.exit(1)
    })
}
