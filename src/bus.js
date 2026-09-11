import { EventEmitter } from 'node:events';

// 进程内事件总线：引擎产出 -> SSE / 通知
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const Events = {
  CANDIDATE: 'candidate', // 新候选入库
  UPDATE: 'update', // 候选快照/打分更新
  ALERT: 'alert', // 分级告警 (T1-T3)
  POOLS_CHANGED: 'pools_changed', // 毕业池集合变化，需重建 Swap 订阅
};
