/** 标签行：标签名 + 全仓库出现次数（Rust scan_vault_tags 返回，候选按 count 降序）。 */
export interface TagRow {
  tag: string;
  count: number;
}
