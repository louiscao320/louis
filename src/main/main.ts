import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { channels } from "../shared/channels.js";
import type { NetworkConfig, NetworkStatus, OutboundReceipt, PrintOutboundOptions, PrinterInfo } from "../shared/types.js";
import { InventoryStore } from "./inventory-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let store: InventoryStore | null = null;
let dataDir = "";
let networkConfigPath = "";
let networkConfig: NetworkConfig = { mode: "local", hostPort: 8787, serverUrl: "" };
let lanServer: http.Server | null = null;

function getStore() {
  if (!store) throw new Error("数据库尚未初始化");
  return store;
}

const apiMethods = [
  "login",
  "listUsers",
  "createUser",
  "updateUser",
  "deleteUser",
  "getCatalog",
  "createProduct",
  "updateProduct",
  "deleteProduct",
  "createSku",
  "updateSku",
  "deleteSku",
  "createPartner",
  "updatePartner",
  "deletePartner",
  "listInboundOrders",
  "createInboundOrder",
  "approveInboundOrder",
  "voidInboundOrder",
  "listOutboundOrders",
  "createOutboundOrder",
  "approveOutboundOrder",
  "voidOutboundOrder",
  "transferToStorefront",
  "addStorefrontStock",
  "assertOutboundOrderReadyToApprove",
  "getOutboundReceipt",
  "getInventory",
  "getDashboard",
  "getMovements",
  "getProfitReport",
  "exportExcel",
  "createBackup",
  "listBackups"
] as const;

type ApiMethod = (typeof apiMethods)[number];

function normalizeServerUrl(serverUrl: string): string {
  const value = serverUrl.trim().replace(/\/+$/, "");
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function loadNetworkConfig() {
  try {
    const raw = fs.readFileSync(networkConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NetworkConfig>;
    networkConfig = {
      mode: parsed.mode === "host" || parsed.mode === "client" ? parsed.mode : "local",
      hostPort: Number(parsed.hostPort || 8787),
      serverUrl: normalizeServerUrl(parsed.serverUrl || "")
    };
  } catch {
    networkConfig = { mode: "local", hostPort: 8787, serverUrl: "" };
  }
}

function saveNetworkConfig(config: NetworkConfig) {
  networkConfig = {
    mode: config.mode,
    hostPort: Number(config.hostPort || 8787),
    serverUrl: normalizeServerUrl(config.serverUrl || "")
  };
  fs.writeFileSync(networkConfigPath, JSON.stringify(networkConfig, null, 2));
}

function getLanUrls(port = networkConfig.hostPort) {
  const urls = new Set<string>([`http://127.0.0.1:${port}`]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${port}`);
      }
    }
  }
  return [...urls];
}

function getNetworkStatus(): NetworkStatus {
  return {
    config: networkConfig,
    serverRunning: Boolean(lanServer?.listening),
    lanUrls: networkConfig.mode === "host" ? getLanUrls(networkConfig.hostPort) : []
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        request.destroy();
        reject(new Error("请求内容过大"));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("请求格式不是JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

async function callLocalStore(method: ApiMethod, args: unknown[] = []) {
  const inventoryStore = getStore() as unknown as Record<string, (...params: unknown[]) => unknown>;
  if (!apiMethods.includes(method) || typeof inventoryStore[method] !== "function") {
    throw new Error(`不支持的接口：${method}`);
  }
  return await inventoryStore[method](...(args as never[]));
}

async function callRemoteStore(method: ApiMethod, args: unknown[] = []) {
  if (!networkConfig.serverUrl) throw new Error("请先填写主机地址");
  const response = await fetch(`${normalizeServerUrl(networkConfig.serverUrl)}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args })
  });
  const payload = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error || `主机请求失败：${response.status}`);
  return payload.result;
}

async function callDataMethod(method: ApiMethod, args: unknown[] = []) {
  if (networkConfig.mode === "client") {
    return callRemoteStore(method, args);
  }
  return callLocalStore(method, args);
}

async function startLanServer() {
  if (networkConfig.mode !== "host") {
    await stopLanServer();
    return;
  }
  if (lanServer?.listening) {
    const address = lanServer.address();
    if (typeof address === "object" && address?.port === networkConfig.hostPort) return;
    await stopLanServer();
  }
  lanServer = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, app: "kucun", time: new Date().toISOString() });
      return;
    }
    if (request.method !== "POST" || request.url !== "/api") {
      sendJson(response, 404, { ok: false, error: "接口不存在" });
      return;
    }
    try {
      const body = (await readRequestBody(request)) as { method?: ApiMethod; args?: unknown[] };
      if (!body.method || !apiMethods.includes(body.method)) throw new Error("接口不允许访问");
      const result = await callLocalStore(body.method, Array.isArray(body.args) ? body.args : []);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    lanServer?.once("error", reject);
    lanServer?.listen(networkConfig.hostPort, "0.0.0.0", () => resolve());
  });
}

async function stopLanServer() {
  if (!lanServer) return;
  await new Promise<void>((resolve) => lanServer?.close(() => resolve()));
  lanServer = null;
}

async function testServerConnection(serverUrl: string) {
  const response = await fetch(`${normalizeServerUrl(serverUrl)}/health`);
  if (!response.ok) return false;
  const payload = (await response.json()) as { ok?: boolean };
  return Boolean(payload.ok);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value: number): string {
  return Number(value ?? 0).toFixed(2);
}

function renderReceiptHtml(receipt: OutboundReceipt): string {
  const shouldHideCost = receipt.lines.every((line) => line.costAmount === undefined);
  const lines = receipt.lines
    .map(
      (line) => `
        <tr>
          <td colspan="4" class="name">${escapeHtml(line.productName)} / ${escapeHtml(line.skuName)}</td>
        </tr>
        <tr>
          <td>${escapeHtml(line.skuCode || "-")}</td>
          <td class="num">${line.quantity}${escapeHtml(line.unit)}</td>
          <td class="num">${formatMoney(line.unitPrice)}</td>
          <td class="num">${formatMoney(line.amount)}</td>
        </tr>`
        + (shouldHideCost
          ? ""
          : `<tr class="cost-line">
              <td colspan="2">成本 ${formatMoney(line.costAmount ?? 0)}</td>
              <td colspan="2" class="num">利润 ${formatMoney(line.profitAmount ?? 0)}</td>
            </tr>`)
    )
    .join("");
  const totalCost = receipt.lines.reduce((sum, line) => sum + (line.costAmount ?? 0), 0);
  const totalProfit = receipt.totalAmount - totalCost;

  return `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <style>
          @page { size: 80mm auto; margin: 3mm; }
          * { box-sizing: border-box; }
          body {
            width: 72mm;
            margin: 0;
            color: #000;
            font-family: "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
            font-size: 11px;
            line-height: 1.35;
          }
          h1 {
            margin: 0 0 6px;
            text-align: center;
            font-size: 16px;
          }
          .meta, .total, .footer { border-top: 1px dashed #000; padding-top: 6px; margin-top: 6px; }
          .row { display: flex; justify-content: space-between; gap: 8px; }
          table { width: 100%; border-collapse: collapse; margin-top: 6px; }
          th, td { padding: 2px 0; vertical-align: top; }
          th { border-top: 1px dashed #000; border-bottom: 1px dashed #000; font-weight: 700; text-align: left; }
          .name { padding-top: 5px; font-weight: 700; }
          .cost-line td { color: #333; font-size: 10px; }
          .num { text-align: right; white-space: nowrap; }
          .total strong { font-size: 15px; }
          .footer { text-align: center; }
        </style>
      </head>
      <body>
        <h1>销售小票</h1>
        <div class="meta">
          <div class="row"><span>单号</span><span>${escapeHtml(receipt.orderNo)}</span></div>
          <div class="row"><span>日期</span><span>${escapeHtml(receipt.orderDate)}</span></div>
          <div class="row"><span>客户</span><span>${escapeHtml(receipt.customerName || "散客")}</span></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>编码</th>
              <th class="num">数量</th>
              <th class="num">单价</th>
              <th class="num">金额</th>
            </tr>
          </thead>
          <tbody>${lines}</tbody>
        </table>
        <div class="total">
          <div class="row"><strong>合计</strong><strong>¥${formatMoney(receipt.totalAmount)}</strong></div>
          ${
            shouldHideCost
              ? ""
              : `<div class="row"><span>成本</span><span>¥${formatMoney(totalCost)}</span></div>
                 <div class="row"><span>利润</span><span>¥${formatMoney(totalProfit)}</span></div>`
          }
        </div>
        ${receipt.note ? `<div class="meta">备注：${escapeHtml(receipt.note)}</div>` : ""}
        <div class="footer">谢谢惠顾</div>
      </body>
    </html>`;
}

async function printReceipt(receipt: OutboundReceipt, options: PrintOutboundOptions = {}) {
  const printableReceipt = options.hideCost === false ? receipt : { ...receipt, lines: receipt.lines.map(({ costAmount, profitAmount, ...line }) => line) };
  const printWindow = new BrowserWindow({
    width: 360,
    height: 680,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  try {
    const encoded = encodeURIComponent(renderReceiptHtml(printableReceipt));
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encoded}`);
    await new Promise<void>((resolve, reject) => {
      printWindow.webContents.print(
        {
          silent: Boolean(options.silent),
          printBackground: true,
          deviceName: options.printerName || undefined,
          margins: { marginType: "none" }
        },
        (success, failureReason) => {
          if (success) {
            resolve();
          } else {
            reject(new Error(failureReason || "打印失败"));
          }
        }
      );
    });
  } finally {
    printWindow.close();
  }
}

function registerHandlers() {
  ipcMain.handle(channels.login, (_event, input) => callDataMethod("login", [input]));
  ipcMain.handle(channels.listUsers, () => callDataMethod("listUsers"));
  ipcMain.handle(channels.createUser, (_event, input) => callDataMethod("createUser", [input]));
  ipcMain.handle(channels.updateUser, (_event, id, input) => callDataMethod("updateUser", [id, input]));
  ipcMain.handle(channels.deleteUser, (_event, id) => callDataMethod("deleteUser", [id]));
  ipcMain.handle(channels.getCatalog, () => callDataMethod("getCatalog"));
  ipcMain.handle(channels.createProduct, (_event, input) => callDataMethod("createProduct", [input]));
  ipcMain.handle(channels.updateProduct, (_event, id, input) => callDataMethod("updateProduct", [id, input]));
  ipcMain.handle(channels.deleteProduct, (_event, id) => callDataMethod("deleteProduct", [id]));
  ipcMain.handle(channels.createSku, (_event, input) => callDataMethod("createSku", [input]));
  ipcMain.handle(channels.updateSku, (_event, id, input) => callDataMethod("updateSku", [id, input]));
  ipcMain.handle(channels.deleteSku, (_event, id) => callDataMethod("deleteSku", [id]));
  ipcMain.handle(channels.createPartner, (_event, input) => callDataMethod("createPartner", [input]));
  ipcMain.handle(channels.updatePartner, (_event, id, input) => callDataMethod("updatePartner", [id, input]));
  ipcMain.handle(channels.deletePartner, (_event, id) => callDataMethod("deletePartner", [id]));
  ipcMain.handle(channels.listInboundOrders, () => callDataMethod("listInboundOrders"));
  ipcMain.handle(channels.createInboundOrder, (_event, input) => callDataMethod("createInboundOrder", [input]));
  ipcMain.handle(channels.approveInboundOrder, (_event, id) => callDataMethod("approveInboundOrder", [id]));
  ipcMain.handle(channels.voidInboundOrder, (_event, id) => callDataMethod("voidInboundOrder", [id]));
  ipcMain.handle(channels.listOutboundOrders, () => callDataMethod("listOutboundOrders"));
  ipcMain.handle(channels.createOutboundOrder, (_event, input) => callDataMethod("createOutboundOrder", [input]));
  ipcMain.handle(channels.approveOutboundOrder, (_event, id) => callDataMethod("approveOutboundOrder", [id]));
  ipcMain.handle(channels.voidOutboundOrder, (_event, id) => callDataMethod("voidOutboundOrder", [id]));
  ipcMain.handle(channels.transferToStorefront, (_event, input) => callDataMethod("transferToStorefront", [input]));
  ipcMain.handle(channels.addStorefrontStock, (_event, input) => callDataMethod("addStorefrontStock", [input]));
  ipcMain.handle(channels.listPrinters, async (): Promise<PrinterInfo[]> => {
    const printers = await (mainWindow ?? BrowserWindow.getAllWindows()[0])?.webContents.getPrintersAsync();
    return (printers ?? []).map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      isDefault: Boolean(printer.isDefault),
      status: printer.status
    }));
  });
  ipcMain.handle(channels.printOutboundReceipt, async (_event, id: number, options: PrintOutboundOptions = {}) => {
    if (options.approveAfterPrint) {
      await callDataMethod("assertOutboundOrderReadyToApprove", [id]);
    }
    const receipt = (await callDataMethod("getOutboundReceipt", [id])) as OutboundReceipt;
    await printReceipt(receipt, options);
    if (options.approveAfterPrint) {
      await callDataMethod("approveOutboundOrder", [id]);
    }
  });
  ipcMain.handle(channels.getInventory, () => callDataMethod("getInventory"));
  ipcMain.handle(channels.getDashboard, () => callDataMethod("getDashboard"));
  ipcMain.handle(channels.getMovements, () => callDataMethod("getMovements"));
  ipcMain.handle(channels.getProfitReport, () => callDataMethod("getProfitReport"));
  ipcMain.handle(channels.exportExcel, () => callDataMethod("exportExcel"));
  ipcMain.handle(channels.createBackup, () => callDataMethod("createBackup"));
  ipcMain.handle(channels.listBackups, () => callDataMethod("listBackups"));
  ipcMain.handle(channels.revealPath, (_event, targetPath: string) => shell.showItemInFolder(targetPath));
  ipcMain.handle(channels.getNetworkStatus, () => getNetworkStatus());
  ipcMain.handle(channels.setNetworkConfig, async (_event, config: NetworkConfig) => {
    saveNetworkConfig(config);
    await startLanServer();
    return getNetworkStatus();
  });
  ipcMain.handle(channels.testServerConnection, (_event, serverUrl: string) => testServerConnection(serverUrl));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 720,
    title: "库存管理",
    backgroundColor: "#f7f8fb",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    await mainWindow.loadURL(devServer);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  dataDir = app.getPath("userData");
  networkConfigPath = path.join(dataDir, "network-config.json");
  loadNetworkConfig();
  store = new InventoryStore(path.join(dataDir, "inventory.sqlite"), dataDir);
  store.createDailyBackupIfNeeded();
  registerHandlers();
  await startLanServer();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void stopLanServer();
  store?.close();
});
