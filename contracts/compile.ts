/**
 * Kompilasi BeeworkEscrow.sol dengan solc-js, hasilkan ABI + bytecode ke
 * src/contracts/BeeworkEscrow.json supaya backend dan deploy script pakai
 * artefak yang sama persis.
 *
 *   bun contracts/compile.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
// @ts-expect-error solc tidak menyediakan tipe
import solc from 'solc'

const root = resolve(import.meta.dir, '..')
const source = readFileSync(join(root, 'contracts/src/BeeworkEscrow.sol'), 'utf8')

const input = {
  language: 'Solidity',
  sources: { 'BeeworkEscrow.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] },
    },
  },
}

/** Resolve import @openzeppelin/... dari node_modules. */
const findImports = (path: string) => {
  try {
    return { contents: readFileSync(join(root, 'node_modules', path), 'utf8') }
  } catch {
    return { error: `File not found: ${path}` }
  }
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }))

const errors = (output.errors ?? []) as { severity: string; formattedMessage: string }[]
for (const e of errors) console.error(e.formattedMessage)
if (errors.some((e) => e.severity === 'error')) process.exit(1)

const contract = output.contracts['BeeworkEscrow.sol'].BeeworkEscrow
const artifact = {
  contractName: 'BeeworkEscrow',
  compiler: `solc ${solc.version()}`,
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
}

const out = join(root, 'src/contracts/BeeworkEscrow.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(artifact, null, 2))

// ABI bertipe `as const` supaya viem bisa menyimpulkan tipe argumen event & fungsi.
const abiTs = join(root, 'src/contracts/BeeworkEscrow.abi.ts')
writeFileSync(
  abiTs,
  `// Dihasilkan oleh contracts/compile.ts — jangan diedit manual.
export const beeworkEscrowAbi = ${JSON.stringify(contract.abi, null, 2)} as const
`,
)

console.log(`✅ ${out}`)
console.log(`✅ ${abiTs}`)
console.log(`   compiler : ${artifact.compiler}`)
console.log(`   bytecode : ${(artifact.bytecode.length - 2) / 2} bytes`)
console.log(`   abi      : ${artifact.abi.length} entries`)
