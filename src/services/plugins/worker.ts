/**
 * 插件隔离上下文（Web Worker）与桥代理。
 *
 * 插件入口代码与一段桥代理源码拼接后作为 blob Worker 执行：worker 内没有 window /
 * `__TAURI_INTERNALS__` / invoke，插件只能经 `self.bridge` 与主线程通信——
 * 桥是插件触达 App 能力的唯一通道（无裸 IPC）。
 *
 * 代理协议：
 * - 插件 → 主线程：`{ kind: "call", seq, method, args }`（bridge 方法调用），主线程回 `reply`。
 * - 主线程 → 插件：`{ kind: "invoke", seq, fnId, args }` 运行插件注册的函数（如工具 execute），插件回 `reply`；
 *   `{ kind: "event", event, payload }` 事件投递。
 *
 * 注册类方法（registerTool 等）参数中的函数会被代理存为 fnId 引用，序列化只过描述信息。
 * 桥方法白名单在 `BRIDGE_METHODS`：新增方法 = 在 `bridge.ts` 宿主登记处理 + 此处登记方法名。
 */

/** 桥方法白名单（自动暴露给插件的 bridge.<method> 入口）。
 * 仅承载 worker 平面可表达的方法（tool/background 类插件）；UI 类贡献（panel/node/setting/theme/app/command）
 * 走主线程平面（Phase C，主线程才能渲染/触达菜单），不在此列。 */
export const BRIDGE_METHODS = [
  "stateRead",
  "stateWrite",
  "ready",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** 主线程 → 插件：运行插件注册的函数。 */
export interface WorkerInvokeMessage {
  kind: "invoke";
  seq: number;
  fnId: string;
  args: unknown[];
}

/** 主线程 → 插件：事件投递。 */
export interface WorkerEventMessage {
  kind: "event";
  event: string;
  payload: unknown;
}

/** 插件 → 主线程：桥调用。 */
export interface WorkerCallMessage {
  kind: "call";
  seq: number;
  method: string;
  args: unknown[];
}

export type PluginWorkerOutboundMessage = WorkerInvokeMessage | WorkerEventMessage;

/** 插件工具注册规格（worker 侧序列化形态：execute 被存为 fnId，其余字段透传）。 */
export interface PluginToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parallelSafe?: boolean;
  executeId: string;
}

/** 插件命令注册规格（worker 侧序列化形态：run 被存为 fnId）。 */
export interface PluginCommandSpec {
  id: string;
  label: string;
  runId: string;
}

/**
 * 桥代理源码（经典 worker 脚本，拼接在插件代码之前）。
 * 注：代码刻意保持无依赖、ES5 风格——它跑在无 bundler 的 worker 全局里。
 */
export function buildProxySource(): string {
  const generic = BRIDGE_METHODS.map(
    (m) =>
      `bridge[${JSON.stringify(m)}]=function(){return call(${JSON.stringify(m)},Array.prototype.slice.call(arguments));};`,
  ).join("\n");
  return `(function(){
var seq=0;var pending={};var fns={};var subs=[];
self.addEventListener("message",function(e){
  var m=e.data;if(!m||typeof m!=="object")return;
  if(m.kind==="reply"){var p=pending[m.seq];if(!p)return;delete pending[m.seq];m.ok?p[0](m.result):p[1](new Error(m.error||"bridge error"));}
  else if(m.kind==="event"){for(var i=0;i<subs.length;i++)subs[i](m.event,m.payload);}
  else if(m.kind==="invoke"){var f=fns[m.fnId];if(!f){self.postMessage({kind:"reply",seq:m.seq,ok:false,error:"unknown fn"});return;}
    Promise.resolve().then(function(){return f.apply(null,m.args||[]);}).then(function(r){self.postMessage({kind:"reply",seq:m.seq,ok:true,result:r});},
      function(err){self.postMessage({kind:"reply",seq:m.seq,ok:false,error:err&&err.message?err.message:String(err)});});}
});
function call(method,args){var s=++seq;return new Promise(function(res,rej){pending[s]=[res,rej];self.postMessage({kind:"call",seq:s,method:method,args:args||[]});});}
function reg(fn){var id="f"+(++seq);fns[id]=fn;return id;}
var bridge={};
bridge.registerTool=function(def){
  if(!def||typeof def.execute!=="function")return Promise.reject(new Error("registerTool 需要 { name, description, parameters, execute }"));
  return call("registerTool",[{name:def.name,description:def.description,parameters:def.parameters||{},parallelSafe:!!def.parallelSafe,executeId:reg(def.execute)}]);
};
bridge.registerCommand=function(cmd){
  if(!cmd||typeof cmd.run!=="function")return Promise.reject(new Error("registerCommand 需要 { id, label, run }"));
  return call("registerCommand",[{id:cmd.id,label:cmd.label,runId:reg(cmd.run)}]);
};
${generic}
bridge.on=function(event,cb){if(typeof cb!=="function")return Promise.reject(new Error("on 需要回调函数"));return call("subscribe",[event]).then(function(){subs.push(cb);});};
self.bridge=bridge;
})();
`;
}

/** 创建插件隔离上下文（blob Worker）；dispose 终止 worker 并释放 blob URL。 */
export function createPluginWorker(code: string): { worker: Worker; dispose: () => void } {
  const source = `${buildProxySource()}\n;\n${code}`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
  return {
    worker,
    dispose: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
