// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// V3 往返模拟检查器（Uniswap V3 / SwapRouter02 形态，exactInputSingle 无 deadline 字段）。
// 与 V2 版同思路：eth_call + stateOverride 注入本字节码到固定地址并覆写余额提供 msg.value，
// 在 RPC 内存里跑「原生币买 token → approve → 卖回原生币」一个往返。
// V3 没有 SupportingFeeOnTransfer 变体：高税/貔貅代币会让某一腿 revert 或到手极少，
// 据此区分：买入 revert=未开池/反机器人→WAIT；卖出 revert=疑似貔貅→REJECT。
// 状态码与 V2 版对齐：0=正常, 1=买入revert, 2=买到0个, 3=卖出revert。
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    // SwapRouter02：payable，tokenIn==WETH 且带 msg.value 时路由器自动包装原生币。
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract RoundTripCheckerV3 {
    // weth：链上「包装原生币」地址（BSC=WBNB）。fee：目标池费率(500/2500/3000/10000...)。
    // 买入用 msg.value（tokenIn=weth），卖出把买到的全部 token 换回 weth，按 weth 余额差计 gotSell。
    function checkV3(
        address router,
        address weth,
        address token,
        uint24 fee
    ) external payable returns (uint8 status, uint256 gotBuy, uint256 gotSell) {
        IV3SwapRouter r = IV3SwapRouter(router);

        try r.exactInputSingle{value: msg.value}(IV3SwapRouter.ExactInputSingleParams({
            tokenIn: weth,
            tokenOut: token,
            fee: fee,
            recipient: address(this),
            amountIn: msg.value,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        })) {} catch {
            return (1, 0, 0);
        }

        gotBuy = IERC20(token).balanceOf(address(this));
        if (gotBuy == 0) return (2, 0, 0);

        IERC20(token).approve(router, gotBuy);
        uint256 wethBefore = IERC20(weth).balanceOf(address(this));
        try r.exactInputSingle(IV3SwapRouter.ExactInputSingleParams({
            tokenIn: token,
            tokenOut: weth,
            fee: fee,
            recipient: address(this),
            amountIn: gotBuy,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        })) {
            gotSell = IERC20(weth).balanceOf(address(this)) - wethBefore;
            return (0, gotBuy, gotSell);
        } catch {
            return (3, gotBuy, 0);
        }
    }

    receive() external payable {}
}
