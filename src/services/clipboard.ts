/**
 * 系统剪贴板写入 service（表格放大预览右键「复制图片」用）。
 *
 * 链路：dataURL → 离屏 Image 解码 → canvas 取 RGBA → 核心 `plugin:image|new` 建资源 →
 * clipboard 插件 `write_image`（arboard 写系统剪贴板，含透明通道）。
 * 纯 I/O 封装：解码失败/画布不可用/剪贴板被占用均抛错，由调用方降级提示。
 */
import { Image } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

/** 复制 dataURL 图片到系统剪贴板（PNG 透明通道保留；GIF 取首帧）。 */
export async function copyImageToClipboard(dataUrl: string): Promise<void> {
  const el = new window.Image();
  el.src = dataUrl;
  await el.decode();
  const w = el.naturalWidth;
  const h = el.naturalHeight;
  if (!w || !h) throw new Error("图片解码失败");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(el, 0, 0);
  const rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data);
  const img = await Image.new(rgba, w, h);
  await writeImage(img);
}
