export type OrderStatus = "draft" | "approved" | "voided";
export type PartnerType = "supplier" | "customer";
export type MovementType = "in" | "out";
export type StockLocation = "warehouse" | "storefront";
export type NetworkMode = "local" | "host" | "client";
export type UserRole = "admin" | "storefront" | "warehouse";

export interface Product {
  id: number;
  name: string;
  code: string | null;
  category: string | null;
  note: string | null;
  isActive: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Sku {
  id: number;
  productId: number;
  productName?: string;
  name: string;
  skuCode: string | null;
  barcode: string | null;
  unit: string;
  defaultCost: number;
  defaultPrice: number;
  lowStockThreshold: number;
  isActive: boolean;
  currentStock?: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Partner {
  id: number;
  type: PartnerType;
  name: string;
  contact: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  isMember: boolean;
  memberDiscounts: MemberProductDiscount[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemberProductDiscount {
  productName: string;
  discountAmount: number;
}

export interface OrderLineInput {
  skuId: number;
  quantity: number;
  unitCost?: number;
  unitPrice?: number;
  note?: string;
}

export interface InboundOrderInput {
  supplierId?: number | null;
  orderDate: string;
  note?: string;
  lines: (Required<Pick<OrderLineInput, "skuId" | "quantity" | "unitCost">> & Pick<OrderLineInput, "note">)[];
}

export interface OutboundOrderInput {
  customerId?: number | null;
  orderDate: string;
  note?: string;
  lines: (Required<Pick<OrderLineInput, "skuId" | "quantity" | "unitPrice">> & Pick<OrderLineInput, "note">)[];
}

export interface OrderListItem {
  id: number;
  orderNo: string;
  status: OrderStatus;
  partnerName: string | null;
  orderDate: string;
  totalAmount: number;
  totalCost?: number;
  totalProfit?: number;
  note: string | null;
  createdAt: string;
  approvedAt: string | null;
  voidedAt: string | null;
}

export interface InventoryRow {
  skuId: number;
  productName: string;
  skuName: string;
  skuCode: string | null;
  unit: string;
  defaultCost: number;
  defaultPrice: number;
  lowStockThreshold: number;
  warehouseStock: number;
  storefrontStock: number;
  currentStock: number;
  stockValue: number;
  isLowStock: boolean;
}

export interface StockTransferInput {
  skuId: number;
  quantity: number;
  note?: string;
}

export interface StockIncreaseInput {
  skuId: number;
  quantity: number;
  unitCost: number;
  note?: string;
}

export interface MovementRow {
  id: number;
  skuId: number;
  productName: string;
  skuName: string;
  type: MovementType;
  quantity: number;
  unitCost: number | null;
  unitPrice: number | null;
  costAmount: number;
  salesAmount: number;
  profitAmount: number;
  orderType: string;
  orderNo: string | null;
  note: string | null;
  occurredAt: string;
}

export interface ProfitRow {
  skuId: number;
  productName: string;
  skuName: string;
  quantity: number;
  salesAmount: number;
  costAmount: number;
  profitAmount: number;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
}

export interface ReceiptLine {
  productName: string;
  skuName: string;
  skuCode: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  costAmount?: number;
  profitAmount?: number;
}

export interface OutboundReceipt {
  orderId: number;
  orderNo: string;
  status: OrderStatus;
  customerName: string | null;
  orderDate: string;
  note: string | null;
  totalAmount: number;
  lines: ReceiptLine[];
}

export interface PrintOutboundOptions {
  printerName?: string | null;
  silent?: boolean;
  approveAfterPrint?: boolean;
  hideCost?: boolean;
}

export interface Dashboard {
  skuCount: number;
  totalStock: number;
  stockValue: number;
  lowStockCount: number;
  salesAmount: number;
  profitAmount: number;
}

export interface BackupInfo {
  fileName: string;
  fullPath: string;
  size: number;
  createdAt: string;
}

export interface CatalogPayload {
  products: Product[];
  skus: Sku[];
  suppliers: Partner[];
  customers: Partner[];
}

export interface NetworkConfig {
  mode: NetworkMode;
  hostPort: number;
  serverUrl: string;
}

export interface NetworkStatus {
  config: NetworkConfig;
  serverRunning: boolean;
  lanUrls: string[];
}

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface UserInput {
  username: string;
  password?: string;
  role: UserRole;
  isActive?: boolean;
}

export interface AppApi {
  login(input: LoginInput): Promise<AuthUser>;
  listUsers(): Promise<AuthUser[]>;
  createUser(input: UserInput): Promise<AuthUser>;
  updateUser(id: number, input: UserInput): Promise<AuthUser>;
  deleteUser(id: number): Promise<void>;
  getCatalog(): Promise<CatalogPayload>;
  createProduct(input: Partial<Product>): Promise<Product>;
  updateProduct(id: number, input: Partial<Product>): Promise<Product>;
  deleteProduct(id: number): Promise<void>;
  createSku(input: Partial<Sku>): Promise<Sku>;
  updateSku(id: number, input: Partial<Sku>): Promise<Sku>;
  deleteSku(id: number): Promise<void>;
  createPartner(input: Partial<Partner>): Promise<Partner>;
  updatePartner(id: number, input: Partial<Partner>): Promise<Partner>;
  deletePartner(id: number): Promise<void>;
  listInboundOrders(): Promise<OrderListItem[]>;
  createInboundOrder(input: InboundOrderInput): Promise<OrderListItem>;
  approveInboundOrder(id: number): Promise<void>;
  voidInboundOrder(id: number): Promise<void>;
  listOutboundOrders(): Promise<OrderListItem[]>;
  createOutboundOrder(input: OutboundOrderInput): Promise<OrderListItem>;
  approveOutboundOrder(id: number): Promise<void>;
  voidOutboundOrder(id: number): Promise<void>;
  transferToStorefront(input: StockTransferInput): Promise<void>;
  addStorefrontStock(input: StockIncreaseInput): Promise<void>;
  listPrinters(): Promise<PrinterInfo[]>;
  printOutboundReceipt(id: number, options?: PrintOutboundOptions): Promise<void>;
  getInventory(): Promise<InventoryRow[]>;
  getDashboard(): Promise<Dashboard>;
  getMovements(): Promise<MovementRow[]>;
  getProfitReport(): Promise<ProfitRow[]>;
  exportExcel(): Promise<string>;
  createBackup(): Promise<string>;
  listBackups(): Promise<BackupInfo[]>;
  revealPath(path: string): Promise<void>;
  getNetworkStatus(): Promise<NetworkStatus>;
  setNetworkConfig(config: NetworkConfig): Promise<NetworkStatus>;
  testServerConnection(serverUrl: string): Promise<boolean>;
}
