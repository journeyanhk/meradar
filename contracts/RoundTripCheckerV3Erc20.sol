// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// V3（SwapRouter v1 形态）ERC-20 报价币往返检查器。
// 用于报价币不是「包装原生币」的池子 —— 典型是 Arc：报价币 USDC(0x3600…) 是「原生余额的 ERC-20 视图」，
// 覆写 CHECKER 的原生余额即等于给它等值 USDC（原生 18 位 = ERC-20 6 位 × 1e12），无需存储槽覆写、无 WUSDC 包装。
// 与原生版(checkV3)的两点差异：
//   ① 买入不发 msg.value，先 approve 报价币，由路由器 transferFrom 拉取（在 Arc 上即扣原生余额）；
//   ② 路由 exactInputSingle 参数带 deadline 字段（SwapRouter v1，selector 0x414bf389），非 SwapRouter02。
// 状态码与 V2/V3 版对齐：0=正常, 1=买入 revert, 2=买到 0 个, 3=卖出 revert。
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IV3SwapRouterV1 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline; // v1 独有；SwapRouter02 无此字段
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract RoundTripCheckerV3Erc20 {
    // router：SwapRouter v1。quote：报价币(Arc USDC / 普通 ERC-20)。token：目标币。fee：池费率。
    // amountIn：报价币最小单位的探针额度（USDC 为 6 位，如 5 USDC = 5_000_000）。
    function checkV3Erc20(
        address router,
        address quote,
        address token,
        uint24 fee,
        uint256 amountIn
    ) external payable returns (uint8 status, uint256 gotBuy, uint256 gotSell) {
        IV3SwapRouterV1 r = IV3SwapRouterV1(router);
        uint256 dl = block.timestamp + 1200;

        // 授权路由器拉取报价币（低级 call 忽略返回值，兼容非标准 ERC-20）。
        (bool _a, ) = quote.call(abi.encodeWithSelector(IERC20.approve.selector, router, amountIn));
        _a;

        try r.exactInputSingle(IV3SwapRouterV1.ExactInputSingleParams({
            tokenIn: quote,
            tokenOut: token,
            fee: fee,
            recipient: address(this),
            deadline: dl,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        })) {} catch {
            return (1, 0, 0);
        }

        gotBuy = IERC20(token).balanceOf(address(this));
        if (gotBuy == 0) return (2, 0, 0);

        (bool _b, ) = token.call(abi.encodeWithSelector(IERC20.approve.selector, router, gotBuy));
        _b;
        uint256 quoteBefore = IERC20(quote).balanceOf(address(this));
        try r.exactInputSingle(IV3SwapRouterV1.ExactInputSingleParams({
            tokenIn: token,
            tokenOut: quote,
            fee: fee,
            recipient: address(this),
            deadline: dl,
            amountIn: gotBuy,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        })) {
            gotSell = IERC20(quote).balanceOf(address(this)) - quoteBefore;
            return (0, gotBuy, gotSell);
        } catch {
            return (3, gotBuy, 0);
        }
    }

    receive() external payable {}
}
