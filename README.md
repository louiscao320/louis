# 库存管理桌面系统

这是一个本地库存出入库管理工具，支持 Mac/Windows 桌面应用、本地 SQLite 数据库、商品/SKU、客户供应商、入库单、出库单、FIFO 批次成本、库存报表、利润报表、Excel 导出和自动备份。

## 常用命令

```bash
pnpm dev
```

启动开发版桌面应用。

```bash
pnpm build
```

生成生产构建。

```bash
pnpm test
```

运行库存核心逻辑测试，包括 FIFO 成本、库存不足拦截、出库作废恢复库存。

```bash
pnpm package:mac
pnpm package:win
```

打包 Mac 或 Windows 安装包。Windows 打包通常建议在 Windows 环境运行。

## 生成 Windows 安装包的其他办法

如果 Mac 上打包 Windows 安装包时下载失败，建议用 GitHub 自动打包：

1. 把这个项目上传到 GitHub。
2. 打开项目页面的 `Actions`。
3. 选择 `Windows 安装包`。
4. 点击 `Run workflow`。
5. 等待完成后，在页面底部下载 `kucun-windows-installer`。

这种方式会在真正的 Windows 环境里打包，数据库组件和安装器工具都会自动匹配 Windows。

## 数据位置

正式运行时，数据库会保存在 Electron 的应用数据目录中，文件名为 `inventory.sqlite`。系统每天首次打开会自动生成一份备份，也可以在“备份导出”页面手动备份或导出 Excel。
