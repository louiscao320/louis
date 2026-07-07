import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../shared/channels.js";
import type { AppApi } from "../shared/types.js";

const api: AppApi = {
  login: (input) => ipcRenderer.invoke(channels.login, input),
  listUsers: () => ipcRenderer.invoke(channels.listUsers),
  createUser: (input) => ipcRenderer.invoke(channels.createUser, input),
  updateUser: (id, input) => ipcRenderer.invoke(channels.updateUser, id, input),
  deleteUser: (id) => ipcRenderer.invoke(channels.deleteUser, id),
  getCatalog: () => ipcRenderer.invoke(channels.getCatalog),
  createProduct: (input) => ipcRenderer.invoke(channels.createProduct, input),
  updateProduct: (id, input) => ipcRenderer.invoke(channels.updateProduct, id, input),
  deleteProduct: (id) => ipcRenderer.invoke(channels.deleteProduct, id),
  createSku: (input) => ipcRenderer.invoke(channels.createSku, input),
  updateSku: (id, input) => ipcRenderer.invoke(channels.updateSku, id, input),
  deleteSku: (id) => ipcRenderer.invoke(channels.deleteSku, id),
  createPartner: (input) => ipcRenderer.invoke(channels.createPartner, input),
  updatePartner: (id, input) => ipcRenderer.invoke(channels.updatePartner, id, input),
  deletePartner: (id) => ipcRenderer.invoke(channels.deletePartner, id),
  listInboundOrders: () => ipcRenderer.invoke(channels.listInboundOrders),
  createInboundOrder: (input) => ipcRenderer.invoke(channels.createInboundOrder, input),
  approveInboundOrder: (id) => ipcRenderer.invoke(channels.approveInboundOrder, id),
  voidInboundOrder: (id) => ipcRenderer.invoke(channels.voidInboundOrder, id),
  listOutboundOrders: () => ipcRenderer.invoke(channels.listOutboundOrders),
  createOutboundOrder: (input) => ipcRenderer.invoke(channels.createOutboundOrder, input),
  approveOutboundOrder: (id) => ipcRenderer.invoke(channels.approveOutboundOrder, id),
  voidOutboundOrder: (id) => ipcRenderer.invoke(channels.voidOutboundOrder, id),
  transferToStorefront: (input) => ipcRenderer.invoke(channels.transferToStorefront, input),
  addStorefrontStock: (input) => ipcRenderer.invoke(channels.addStorefrontStock, input),
  listPrinters: () => ipcRenderer.invoke(channels.listPrinters),
  printOutboundReceipt: (id, options) => ipcRenderer.invoke(channels.printOutboundReceipt, id, options),
  getInventory: () => ipcRenderer.invoke(channels.getInventory),
  getDashboard: () => ipcRenderer.invoke(channels.getDashboard),
  getMovements: () => ipcRenderer.invoke(channels.getMovements),
  getProfitReport: () => ipcRenderer.invoke(channels.getProfitReport),
  exportExcel: () => ipcRenderer.invoke(channels.exportExcel),
  createBackup: () => ipcRenderer.invoke(channels.createBackup),
  listBackups: () => ipcRenderer.invoke(channels.listBackups),
  revealPath: (path) => ipcRenderer.invoke(channels.revealPath, path),
  getNetworkStatus: () => ipcRenderer.invoke(channels.getNetworkStatus),
  setNetworkConfig: (config) => ipcRenderer.invoke(channels.setNetworkConfig, config),
  testServerConnection: (serverUrl) => ipcRenderer.invoke(channels.testServerConnection, serverUrl)
};

contextBridge.exposeInMainWorld("inventoryAPI", api);
