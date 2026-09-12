// 一次性编译脚本：把 RoundTripChecker.sol / RoundTripCheckerV3.sol 编译成运行时字节码，
// 输出到 src/roundtrip-bytecode.js。solc 只作 devDependency；编译产物(运行时字节码常量)被固化进源码，
// 运行时不依赖 solc。用法：node scripts/compile-checker.mjs
import solc from 'solc';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const units = [
  { file: 'RoundTripChecker.sol', contract: 'RoundTripChecker', runtimeConst: 'CHECKER_RUNTIME', abiConst: 'CHECKER_ABI' },
  { file: 'RoundTripCheckerV3.sol', contract: 'RoundTripCheckerV3', runtimeConst: 'CHECKER_V3_RUNTIME', abiConst: 'CHECKER_V3_ABI' },
];

const input = {
  language: 'Solidity',
  sources: Object.fromEntries(
    units.map((u) => [u.file, { content: readFileSync(join(root, 'contracts', u.file), 'utf8') }]),
  ),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['evm.deployedBytecode.object', 'abi'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors) {
  const fatal = out.errors.filter((e) => e.severity === 'error');
  for (const e of out.errors) console.error(e.formattedMessage);
  if (fatal.length) process.exit(1);
}

const banner = '// 自动生成，勿手改。源：contracts/RoundTripChecker*.sol；重生成：node scripts/compile-checker.mjs\n';
let body = banner;
for (const u of units) {
  const c = out.contracts[u.file][u.contract];
  const runtime = '0x' + c.evm.deployedBytecode.object;
  body += `export const ${u.runtimeConst} = '${runtime}';\n`;
  body += `export const ${u.abiConst} = ${JSON.stringify(c.abi)};\n`;
  console.log(`${u.contract} runtime 字节数:`, (runtime.length - 2) / 2);
}
writeFileSync(join(root, 'src/roundtrip-bytecode.js'), body);
console.log('已写入 src/roundtrip-bytecode.js');
