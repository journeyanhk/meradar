// 一次性编译脚本：把 RoundTripChecker.sol 编译成运行时字节码，输出到 src/roundtrip-bytecode.js。
// solc 只作 devDependency；编译产物(运行时字节码常量)被固化进源码，运行时不依赖 solc。
// 用法：node scripts/compile-checker.mjs
import solc from 'solc';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'contracts/RoundTripChecker.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'RoundTripChecker.sol': { content: source } },
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
const c = out.contracts['RoundTripChecker.sol'].RoundTripChecker;
const runtime = '0x' + c.evm.deployedBytecode.object;
const abi = JSON.stringify(c.abi);

const banner = '// 自动生成，勿手改。源：contracts/RoundTripChecker.sol；重生成：node scripts/compile-checker.mjs\n';
writeFileSync(
  join(root, 'src/roundtrip-bytecode.js'),
  `${banner}export const CHECKER_RUNTIME = '${runtime}';\nexport const CHECKER_ABI = ${abi};\n`,
);
console.log('runtime bytecode 字节数:', (runtime.length - 2) / 2);
console.log('已写入 src/roundtrip-bytecode.js');
