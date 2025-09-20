import { promises as fs } from 'fs'
import path from 'path'
import {
    ModuleRegistry,
    extractFunctionExpression,
    makeFactoryFromFunctionExpression
} from './metro-loader'

export type ModuleSpec = { name: string; path: string }

export async function registerAll(registry: ModuleRegistry, modules: ModuleSpec[]) {
    // Prepare global environment expected by browser-targeted bundle
    const g: any = globalThis as any
    if (!g.self) {
        g.self = g
    }
    // Ensure a global babelHelpers exists for modules that reference it directly
    if (!g.babelHelpers) {
        g.babelHelpers = {
            taggedTemplateLiteralLoose: function (strings) {
                return strings
            },
            inheritsLoose: function (sub, sup) {
                sub.prototype = Object.create(sup.prototype)
                sub.prototype.constructor = sub
            },
            extends: function () {
                const target = arguments[0] || {}
                for (let i = 1; i < arguments.length; i++) {
                    const src = arguments[i]
                    if (src) {
                        for (const k in src) {
                            if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k]
                        }
                    }
                }
                return target
            }
        }
    }

    // Also create a global variable binding so free identifier lookups succeed inside evaluated factories
    try {
        if (
            typeof g.babelHelpers !== 'undefined' &&
            typeof g.babelHelpersVarBound === 'undefined'
        ) {
            g.babelHelpersVarBound = true
            g.eval('var babelHelpers = globalThis.babelHelpers;')
        }
    } catch {}

    // Ensure WebCrypto is available on global
    if (!g.crypto) {
        const nodeCrypto = await import('node:crypto')
        g.crypto = nodeCrypto.webcrypto
    }

    // Synthetic modules that the deobfuscated code expects to resolve via b("...") or d("...")
    // Promise -> native Promise constructor
    registry.register('Promise', function (globals, rb, rc, rd, re, rf, exports, module) {
        module.exports = Promise
    })

    // asyncToGeneratorRuntime -> provides asyncToGenerator(fn)
    registry.register(
        'asyncToGeneratorRuntime',
        function (globals, rb, rc, rd, re, rf, exports, module) {
            exports.asyncToGenerator = function (fn) {
                return function (...args) {
                    const self = this
                    return new Promise(function (resolve, reject) {
                        const gen = fn.apply(self, args)
                        function step(key, arg) {
                            let info
                            try {
                                info = gen[key](arg)
                            } catch (err) {
                                reject(err)
                                return
                            }
                            const { value, done } = info
                            if (done) {
                                resolve(value)
                            } else {
                                Promise.resolve(value).then(
                                    (val) => step('next', val),
                                    (err) => step('throw', err)
                                )
                            }
                        }
                        const castU8 = (x: any): Uint8Array | null => {
                            if (x instanceof Uint8Array) return x
                            if (
                                typeof Buffer !== 'undefined' &&
                                Buffer.isBuffer &&
                                Buffer.isBuffer(x)
                            )
                                return new Uint8Array(x)
                            if (
                                x &&
                                typeof x === 'object' &&
                                x.type === 'Buffer' &&
                                Array.isArray(x.data)
                            )
                                return new Uint8Array(x.data)
                            if (Array.isArray(x) && x.every((v) => typeof v === 'number'))
                                return new Uint8Array(x)
                            try {
                                return new Uint8Array(x)
                            } catch {
                                return null
                            }
                        }
                        step('next', undefined)
                    })
                }
            }
        }
    )

    // err -> returns a function that creates Error instances; modules do: throw c("err")("message")
    registry.register('err', function (globals, rb, rc, rd, re, rf, exports, module) {
        module.exports = function (msg) {
            return new Error(String(msg))
        }
    })

    // babelHelpers -> minimal shim used in some logging paths
    registry.register('babelHelpers', function (globals, rb, rc, rd, re, rf, exports, module) {
        const shim = {
            taggedTemplateLiteralLoose: function (strings) {
                return strings
            },
            inheritsLoose: function (sub, sup) {
                sub.prototype = Object.create(sup.prototype)
                sub.prototype.constructor = sub
            },
            extends: function () {
                const target = arguments[0] || {}
                for (let i = 1; i < arguments.length; i++) {
                    const src = arguments[i]
                    if (src) {
                        for (const k in src) {
                            if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k]
                        }
                    }
                }
                return target
            }
        }
        Object.assign(exports, shim)
        if (!globals.babelHelpers) {
            globals.babelHelpers = shim
        }
    })

    for (const entry of modules) {
        const full = entry.path
        let raw
        try {
            raw = await fs.readFile(full, 'utf8')
        } catch (e) {
            throw new Error(`Failed to read module ${entry.name} at ${full}: ${e.message}`)
        }
        const fnExpr = extractFunctionExpression(raw)
        const factory = makeFactoryFromFunctionExpression(fnExpr)
        registry.register(entry.name, factory)
    }
}
