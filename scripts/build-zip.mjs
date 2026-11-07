/*
 * 打插件 zip：release/<包名>-<version>.zip
 *
 * 时间戳固定成 1980-01-01，同一份源码打出来的 zip 逐字节一致
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { crc32 } from "node:zlib"

const repoRoot = join(import.meta.dirname, "..")
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"))
const version = String(pkg.version ?? "")
if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`package.json 的 version 不合法：${version}`)
    process.exit(1)
}

const entries = ["package.json", ...(Array.isArray(pkg.files) ? pkg.files : [])]
const seen = new Set()
const files = []

async function collect(name) {
    if (seen.has(name)) {
        return
    }
    seen.add(name)
    const path = join(repoRoot, name)
    let info
    try {
        info = await stat(path)
    } catch {
        console.warn(`跳过不存在的文件：${name}`)
        return
    }
    if (info.isFile()) {
        files.push(name)
        return
    }
    if (!info.isDirectory()) {
        return
    }
    for (const child of (await readdir(path)).sort()) {
        await collect(`${name}/${child}`)
    }
}

for (const name of entries) {
    await collect(name)
}
if (files.length === 0) {
    console.error("没有可打包的文件")
    process.exit(1)
}
files.sort()

const DOS_TIME = 0
const DOS_DATE = 0x0021

function localHeader({ name, crc, size }) {
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(size, 18)
    header.writeUInt32LE(size, 22)
    header.writeUInt16LE(Buffer.byteLength(name), 26)
    header.writeUInt16LE(0, 28)
    return header
}

function centralHeader({ name, crc, size, offset }) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(DOS_TIME, 12)
    header.writeUInt16LE(DOS_DATE, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(size, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(Buffer.byteLength(name), 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)
    return header
}

const localParts = []
const centralParts = []
let offset = 0
for (const name of files) {
    const data = await readFile(join(repoRoot, name))
    const crc = crc32(data) >>> 0
    const nameBytes = Buffer.from(name, "utf8")
    const local = Buffer.concat([localHeader({ name, crc, size: data.length }), nameBytes, data])
    localParts.push(local)
    centralParts.push(
        Buffer.concat([centralHeader({ name, crc, size: data.length, offset }), nameBytes]),
    )
    offset += local.length
}

const centralBuffer = Buffer.concat(centralParts)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(files.length, 8)
eocd.writeUInt16LE(files.length, 10)
eocd.writeUInt32LE(centralBuffer.length, 12)
eocd.writeUInt32LE(offset, 16)
eocd.writeUInt16LE(0, 20)

const zip = Buffer.concat([...localParts, centralBuffer, eocd])
const outDir = join(repoRoot, "release")
await mkdir(outDir, { recursive: true })
const localName = String(pkg.name ?? "").split("/").at(-1) ?? "plugin"
const outFile = join(outDir, `${localName}-${version}.zip`)
await writeFile(outFile, zip)
console.log(`已生成 ${outFile}`)
console.log(`  文件数：${files.length}，大小：${(zip.length / 1024).toFixed(1)} kB`)
console.log(`  内容：${files.join(", ")}`)
