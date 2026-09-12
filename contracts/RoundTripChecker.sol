// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// 往返模拟检查器：通过 eth_call 的 stateOverride 注入本合约运行时字节码到固定地址 CHECKER，
// 并覆写 CHECKER 余额提供 msg.value，在 RPC 内存里真实执行「买入 → approve → 卖出」一个往返。
// getAmountsOut 是 view 函数，无法体现转账税/貔貅；只有真正跑一遍 transfer 才知道能不能卖、卖回多少。
//
// 用 SupportingFeeOnTransferTokens 变体：普通 swap 函数在收税代币上会因 INSUFFICIENT_OUTPUT 直接 revert，
// 从而无法区分「高税」与「貔貅」；fee-supporting 变体对高税返回一个很小的量(可测)，对真貔貅(转账被拦)
// 则 gotBuy=0 或卖出 revert。调用方据此判定，且「买入 revert」按未开交易处理走 WAIT，不判 REJECT。
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IV2Router {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

contract RoundTripChecker {
    // 用 msg.value 买入 token（buyPath 首个必须是 WBNB），再全额卖回（sellPath 末个必须是 WBNB）。
    // 不 revert，改返回状态码，让调用方区分「买入失败=未开交易→WAIT」与「卖出失败=貔貅→REJECT」：
    //   status: 0=正常往返, 1=买入 revert(可能未开交易/反机器人), 2=买到 0 个代币, 3=卖出 revert(疑似貔貅)
    // gotBuy=买到的代币量, gotSell=卖回的 BNB 量。
    function checkV2(
        address router,
        address[] calldata buyPath,
        address[] calldata sellPath,
        address token
    ) external payable returns (uint8 status, uint256 gotBuy, uint256 gotSell) {
        IV2Router r = IV2Router(router);
        try r.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            0, buyPath, address(this), block.timestamp
        ) {} catch {
            return (1, 0, 0);
        }

        gotBuy = IERC20(token).balanceOf(address(this));
        if (gotBuy == 0) return (2, 0, 0);

        IERC20(token).approve(router, gotBuy);
        uint256 balBefore = address(this).balance;
        try r.swapExactTokensForETHSupportingFeeOnTransferTokens(
            gotBuy, 0, sellPath, address(this), block.timestamp
        ) {
            gotSell = address(this).balance - balBefore;
            return (0, gotBuy, gotSell);
        } catch {
            return (3, gotBuy, 0);
        }
    }

    receive() external payable {}
}
