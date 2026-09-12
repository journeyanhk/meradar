import { parseAbi, parseAbiItem } from 'viem';

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export const pairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

// PancakeSwap V3 池
export const v3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);

export const routerAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);

// Four.meme Token Manager 事件（topic0 已对照真实日志核验，见 review）
export const fourMemeEvents = parseAbi([
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
  'event TokenPurchase(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
  'event TokenSale(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
]);

export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// 毕业后成交订阅：一条订阅、地址数组、双 topic 覆盖所有已毕业活跃池。
// V2 Swap topic0 = 0xd78ad95f…，V3 Swap topic0 = 0xc42079f9…（已核验）
export const v2SwapEvent = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);
export const v3SwapEvent = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);
export const swapEvents = [v2SwapEvent, v3SwapEvent];

// 毕业时按代币对反查池子地址（免 RPC 无法拿到 pool，故 promote 时主动查一次）
export const v2FactoryAbi = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);
export const v3FactoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

// Four.meme Token Manager 视图：返回某代币的曲线报价币、毕业阈值、募集额、最新价等。
// 关键：同一个 Token Manager 上同时跑 BNB(报价=0x0)、USDT、USD1、甚至任意 ERC20 报价的曲线，
// 事件里的 price/cost/funds 单位都是「该币自己的报价币」；必须靠这个视图拿到报价币才能正确定价。
// 字段顺序已链上核验(选择器 0xe684626b)：[1]=quote [3]=totalSupply [5]=maxRaising [6]=launchTime [8]=funds [9]=lastPrice。
export const tokenManagerAbi = parseAbi([
  'function _tokenInfos(address) view returns (address base, address quote, uint256 template, uint256 totalSupply, uint256 maxOffers, uint256 maxRaising, uint256 launchTime, uint256 offers, uint256 funds, uint256 lastPrice, uint256 K, uint256 T, uint256 status)',
]);
