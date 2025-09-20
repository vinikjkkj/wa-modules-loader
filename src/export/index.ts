#!/usr/bin/env node
import fs from 'fs'
import path from 'path'

function printUsageAndExit() {
    console.error('Usage: wa-export <inputFile.js> <outputDir?>')
    console.error(' - inputFile.js: bundle path')
    console.error(' - outputDir (opcional): output dir')
    console.error("   If not given, will be '<inputDir>/deobfuscated/<inputNameWithoutExt>'")
    process.exit(1)
}

const [, , inputArg, outputArg] = process.argv

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

if (!fs.existsSync(inputFile)) {
    console.error(`Input não encontrado: ${inputFile}`)
    process.exit(1)
}

fs.mkdirSync(outputDir, { recursive: true })

const fileContent = fs.readFileSync(inputFile, 'utf-8')

const parts = fileContent.split('__d(').slice(1)

if (parts.length === 0) {
    console.error('No module found (marker __d( not found).')
    process.exit(2)
}

let count = 0
for (const moduleContent of parts) {
    const [firstToken, ...rest] = moduleContent.split(',')
    const rawName = (firstToken || '').replace(/\"/g, '"').replace(/"/g, '').trim()
    const safeBase =
        rawName && /^[\w\[\]-]+/.test(rawName)
            ? rawName.replace(/[^\w\-\[\]]+/g, '_')
            : `module_${++count}`
    const filePath = path.join(outputDir, `${safeBase}.js`)

    const content = rest.join(',')
    fs.writeFileSync(filePath, content, 'utf-8')
}

console.log(`Export finished. Files saved in: ${outputDir}`)
