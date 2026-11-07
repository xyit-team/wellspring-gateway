/*
 * 测试入口：显式列出 test/ 下的 *.test.ts，串行执行
 */

import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const TEST_ROOT = fileURLToPath(new URL("../test/", import.meta.url))

const files = readdirSync(TEST_ROOT)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(TEST_ROOT, name))

if (files.length === 0) {
    console.error("没有找到测试文件")
    process.exit(1)
}

console.log(`运行 ${files.length} 个测试文件：`)
for (const file of files) {
    console.log(`  ${relative(process.cwd(), file)}`)
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    stdio: "inherit",
})
process.exit(result.status ?? 1)
