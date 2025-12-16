// Minimal Metro-like loader for deobfuscated WA modules
// It supports modules expressed as: ["DepA","DepB",...], (function(a,b,c,d,e,f,g){ ... g.Exported = ... }), <id>);
// We do not execute the raw bundle directly. Instead, we convert each file into a factory function
// of the shape (globals, requireByName, module, exports) and then capture its exports.

export type Factory = (
    globals: any,
    rb: (name: string) => any,
    rc: (name: string) => any,
    rd: (name: string) => any,
    re: (name: string) => any,
    rf: (name: string) => any,
    exports: any,
    module: { exports: any }
) => any

type ModuleRecord = {
    factory: Factory
    exports: any
    normalized?: any
    initialized: boolean
}

export class ModuleRegistry {
    private map: Map<string, ModuleRecord>

    constructor() {
        this.map = new Map()
    }

    register(name: string, factory: Factory): void {
        if (this.map.has(name)) return
        this.map.set(name, { factory, exports: undefined, initialized: false })
    }

    registerValue(name: string, value: any): void {
        this.register(
            name,
            function (
                _globals: any,
                _rb: any,
                _rc: any,
                _rd: any,
                _re: any,
                _rf: any,
                _exports: any,
                module: { exports: any }
            ) {
                module.exports = value
            }
        )
    }

    async registerAsync(
        name: string,
        valueOrLoader: Promise<any> | (() => Promise<any>)
    ): Promise<void> {
        const val =
            typeof valueOrLoader === 'function'
                ? await (valueOrLoader as () => Promise<any>)()
                : await valueOrLoader
        const resolved =
            val && typeof val === 'object' && 'default' in (val as any) ? (val as any).default : val
        this.registerValue(name, resolved)
    }

    require<T = any>(name: string): T {
        const rec = this.map.get(name)
        if (!rec) throw new Error(`Module not found: ${name}`)
        if (!rec.initialized) {
            const module = { exports: {} as any }
            const exports = module.exports
            const requireByName = (depName: string) => this.require(depName)
            // Some modules expect multiple resolver params (b and d). We pass the same resolver for all.
            rec.factory(
                globalThis as any,
                requireByName,
                requireByName,
                requireByName,
                requireByName,
                requireByName,
                exports,
                module
            )
            const raw = (module.exports ?? exports) as any
            rec.exports = raw
            // Normalize default-only exports, so callers can do c('X')() when the module exported default
            rec.normalized =
                raw && typeof raw === 'object' && raw !== null && 'default' in (raw as any)
                    ? (raw as any).default
                    : raw
            rec.initialized = true
        }
        return (rec.normalized !== undefined ? rec.normalized : rec.exports) as T
    }
}

// Helper to wrap a raw function expression string like: function(a,b,c,d,e,f,g){ ... }
// into a real callable factory with stable params.
export function makeFactoryFromFunctionExpression(fnExprSource: string): Factory {
    // We construct a new function with parameters matching our call contract.
    // params: a,b,c,d,e,f,g, module
    // The original code typically references either b("name") or d("name") to resolve modules.
    const wrappedSrc = `return (${fnExprSource});`
    // eslint-disable-next-line no-new-func
    const getFn = new Function(wrappedSrc)
    const original = getFn()
    if (typeof original !== 'function') {
        throw new Error('Parsed factory is not a function')
    }
    // Return a normalized factory that takes (globals, ...resolvers, exports, module)
    return function (
        globals: any,
        rb: any,
        rc: any,
        rd: any,
        re: any,
        rf: any,
        exports: any,
        module: { exports: any }
    ) {
        const arity = original.length
        // Common require resolver: some bundles use b("name"), others d("name").
        // We pass the same resolver function for all resolver params.
        if (arity <= 6) {
            // Modules with 6 parameters expect the exports aggregator as the 6th param.
            // Signature: (a,b,c,d,e,f)
            return original(globals, rb, rc, rd, re, exports)
        } else if (arity === 7) {
            // Signature: (a,b,c,d,e,f,g) where g is exports aggregator
            return original(globals, rb, rc, rd, re, rf, exports)
        } else {
            // Some variants may include an explicit module param as the 8th.
            return original(globals, rb, rc, rd, re, rf, exports, module)
        }
    }
}

// Very simple extractor: tries to find the first top-level "(function(" and take until the matching closing brace followed by ")".
export function extractFunctionExpression(raw: string): string {
    let startIdx = raw.indexOf('(function')
    if (startIdx === -1) {
        // Some module formats may be '__d(function(...) { ... })' (no leading '(' before function)
        const dIdx = raw.indexOf('__d(')
        if (dIdx !== -1) {
            const fnIdx = raw.indexOf('function', dIdx)
            if (fnIdx !== -1) {
                const between = raw.slice(dIdx + '__d('.length, fnIdx)
                if (/^\s*$/.test(between)) {
                    startIdx = fnIdx
                }
            }
        }
        if (startIdx === -1) {
            startIdx = raw.indexOf('function')
        }
    }
    if (startIdx === -1) throw new Error('No function expression wrapper found')
    const openParenIdx = raw.indexOf('{', startIdx)
    if (openParenIdx === -1) throw new Error('No function body start found')
    let depth = 0
    let endIdx = -1
    for (let i = openParenIdx; i < raw.length; i++) {
        const ch = raw[i]
        if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) {
                endIdx = i
                break
            }
        }
    }
    if (endIdx === -1) throw new Error('No matching function body end found')
    // We want the entire function expression from "function(" up to "}".
    // Back up to the start of "function"
    const funcKeywordIdx = raw.lastIndexOf('function', openParenIdx)
    const fnExpr = raw.slice(funcKeywordIdx, endIdx + 1).trim()
    return fnExpr
}
