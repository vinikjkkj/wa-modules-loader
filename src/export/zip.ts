import { promises as fs } from 'fs'
import { inflateRaw } from 'zlib'

const SIG_LOCAL_HEADER = 0x04034b50
const SIG_CENTRAL_HEADER = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50

const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

const EOCD_SIZE = 22
const MAX_COMMENT_SIZE = 0xffff
const ZIP64_LOCATOR_SIZE = 20
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

export type ZipEntry = {
    fileName: string
    method: number
    compressedSize: number
    uncompressedSize: number
    localHeaderOffset: number
}

function inflateRawAsync(input: Buffer, expectedSize: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        inflateRaw(
            input,
            expectedSize > 0 ? { chunkSize: Math.min(expectedSize + 1, 1 << 24) } : {},
            (err, out) => {
                if (err) reject(err)
                else resolve(out)
            }
        )
    })
}

/**
 * Reads the ZIP64 extended information extra field, which only carries the
 * values that overflowed their 32-bit slot, in a fixed order.
 */
function applyZip64Extra(
    extra: Buffer,
    fields: { uncompressedSize: number; compressedSize: number; localHeaderOffset: number }
) {
    let p = 0
    while (p + 4 <= extra.length) {
        const headerId = extra.readUInt16LE(p)
        const size = extra.readUInt16LE(p + 2)
        const body = p + 4
        if (headerId !== 0x0001) {
            p = body + size
            continue
        }

        let q = body
        const readNext = () => {
            const value = Number(extra.readBigUInt64LE(q))
            q += 8
            return value
        }

        if (fields.uncompressedSize === U32_MAX && q + 8 <= body + size) {
            fields.uncompressedSize = readNext()
        }
        if (fields.compressedSize === U32_MAX && q + 8 <= body + size) {
            fields.compressedSize = readNext()
        }
        if (fields.localHeaderOffset === U32_MAX && q + 8 <= body + size) {
            fields.localHeaderOffset = readNext()
        }
        return
    }
}

export class ZipReader {
    private constructor(
        private readonly handle: fs.FileHandle,
        private readonly zipEntries: ZipEntry[]
    ) {}

    static async open(filePath: string): Promise<ZipReader> {
        const handle = await fs.open(filePath, 'r')
        try {
            const { size } = await handle.stat()
            const entries = await ZipReader.readCentralDirectory(handle, size)
            return new ZipReader(handle, entries)
        } catch (e) {
            await handle.close()
            throw e
        }
    }

    private static async readAt(
        handle: fs.FileHandle,
        position: number,
        length: number
    ): Promise<Buffer> {
        const buf = Buffer.alloc(length)
        let read = 0
        while (read < length) {
            const { bytesRead } = await handle.read(buf, read, length - read, position + read)
            if (bytesRead === 0) break
            read += bytesRead
        }
        if (read < length) {
            throw new Error(`Unexpected end of zip file at offset ${position}`)
        }
        return buf
    }

    private static async readCentralDirectory(
        handle: fs.FileHandle,
        size: number
    ): Promise<ZipEntry[]> {
        const tailSize = Math.min(size, EOCD_SIZE + MAX_COMMENT_SIZE)
        const tail = await ZipReader.readAt(handle, size - tailSize, tailSize)

        let eocd = -1
        for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
            if (tail.readUInt32LE(i) === SIG_EOCD) {
                eocd = i
                break
            }
        }
        if (eocd === -1) {
            throw new Error('Not a zip file (end of central directory record not found)')
        }

        let entryCount = tail.readUInt16LE(eocd + 10)
        let cdSize = tail.readUInt32LE(eocd + 12)
        let cdOffset = tail.readUInt32LE(eocd + 16)

        // A zip with more than 65535 entries (or beyond 4 GiB) stores the real
        // values in the ZIP64 records and leaves sentinels in the classic EOCD.
        if (entryCount === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
            const locator = eocd - ZIP64_LOCATOR_SIZE
            if (locator < 0 || tail.readUInt32LE(locator) !== SIG_ZIP64_LOCATOR) {
                throw new Error('Zip requires ZIP64 but the ZIP64 locator is missing')
            }
            const zip64Offset = Number(tail.readBigUInt64LE(locator + 8))
            const zip64 = await ZipReader.readAt(handle, zip64Offset, 56)
            if (zip64.readUInt32LE(0) !== SIG_ZIP64_EOCD) {
                throw new Error('Invalid ZIP64 end of central directory record')
            }
            entryCount = Number(zip64.readBigUInt64LE(32))
            cdSize = Number(zip64.readBigUInt64LE(40))
            cdOffset = Number(zip64.readBigUInt64LE(48))
        }

        const cd = await ZipReader.readAt(handle, cdOffset, cdSize)
        const entries: ZipEntry[] = []

        let p = 0
        for (let i = 0; i < entryCount; i++) {
            if (p + CENTRAL_HEADER_SIZE > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL_HEADER) {
                throw new Error(`Invalid central directory entry #${i + 1}`)
            }

            const method = cd.readUInt16LE(p + 10)
            const nameLen = cd.readUInt16LE(p + 28)
            const extraLen = cd.readUInt16LE(p + 30)
            const commentLen = cd.readUInt16LE(p + 32)

            const fields = {
                uncompressedSize: cd.readUInt32LE(p + 24),
                compressedSize: cd.readUInt32LE(p + 20),
                localHeaderOffset: cd.readUInt32LE(p + 42)
            }

            const nameStart = p + CENTRAL_HEADER_SIZE
            const fileName = cd.toString('utf-8', nameStart, nameStart + nameLen)

            if (
                fields.uncompressedSize === U32_MAX ||
                fields.compressedSize === U32_MAX ||
                fields.localHeaderOffset === U32_MAX
            ) {
                applyZip64Extra(
                    cd.subarray(nameStart + nameLen, nameStart + nameLen + extraLen),
                    fields
                )
            }

            entries.push({
                fileName,
                method,
                compressedSize: fields.compressedSize,
                uncompressedSize: fields.uncompressedSize,
                localHeaderOffset: fields.localHeaderOffset
            })

            p = nameStart + nameLen + extraLen + commentLen
        }

        return entries
    }

    get entries(): ZipEntry[] {
        return this.zipEntries
    }

    async read(entry: ZipEntry): Promise<Buffer> {
        if (entry.compressedSize === 0) return Buffer.alloc(0)

        const header = await ZipReader.readAt(
            this.handle,
            entry.localHeaderOffset,
            LOCAL_HEADER_SIZE
        )
        if (header.readUInt32LE(0) !== SIG_LOCAL_HEADER) {
            throw new Error(`Invalid local header for ${entry.fileName}`)
        }

        // The local header's name/extra lengths can differ from the central
        // directory's, so the data offset must be derived from the local copy.
        const dataOffset =
            entry.localHeaderOffset +
            LOCAL_HEADER_SIZE +
            header.readUInt16LE(26) +
            header.readUInt16LE(28)

        const raw = await ZipReader.readAt(this.handle, dataOffset, entry.compressedSize)

        if (entry.method === METHOD_STORE) return raw
        if (entry.method === METHOD_DEFLATE) {
            return await inflateRawAsync(raw, entry.uncompressedSize)
        }
        throw new Error(`Unsupported compression method ${entry.method} for ${entry.fileName}`)
    }

    async close() {
        await this.handle.close()
    }
}
