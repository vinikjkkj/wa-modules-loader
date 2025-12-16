import { parentPort } from 'worker_threads'

import { buildExportFiles } from './index'

type WorkerRequest = {
    id: number
    bundle: ArrayBuffer
    byteOffset: number
    byteLength: number
    disambiguate: boolean
    toIa: boolean
    mergeCommonNames: boolean
    mergeCommonPrefixes: Array<{ raw: string; isSuffix?: boolean }> | null
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

const BATCH_SIZE = 100

async function handle(req: WorkerRequest) {
    const buf = Buffer.from(req.bundle, req.byteOffset, req.byteLength)
    const text = buf.toString('utf-8')

    const files = await buildExportFiles(text, {
        disambiguate: req.disambiguate,
        toIa: req.toIa,
        mergeCommonNames: req.mergeCommonNames,
        mergeCommonPrefixes: req.mergeCommonPrefixes
    })

    const encoder = new TextEncoder()

    let batch: WorkerChunk['files'] = []
    let transferList: ArrayBuffer[] = []

    const flush = () => {
        if (batch.length === 0) return
        const msg: WorkerChunk = {
            id: req.id,
            kind: 'chunk',
            files: batch
        }
        parentPort?.postMessage(msg, transferList)
        batch = []
        transferList = []
    }

    for (const f of files) {
        const u8 = encoder.encode(f.content)
        const ab = u8.buffer as ArrayBuffer

        batch.push({
            fileName: f.fileName,
            data: ab,
            byteOffset: u8.byteOffset,
            byteLength: u8.byteLength
        })
        transferList.push(ab)

        if (batch.length >= BATCH_SIZE) {
            flush()
        }
    }

    flush()

    const done: WorkerDone = { id: req.id, kind: 'done' }
    parentPort?.postMessage(done)
}

parentPort?.on('message', async (req: WorkerRequest) => {
    try {
        await handle(req)
    } catch (e: any) {
        const err: WorkerError = {
            id: req.id,
            kind: 'error',
            message: e && typeof e.message === 'string' ? e.message : String(e)
        }
        parentPort?.postMessage(err)
    }
})
