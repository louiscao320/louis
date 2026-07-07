import type {
  AppApi,
  AuthUser,
  BackupInfo,
  CatalogPayload,
  Dashboard,
  InboundOrderInput,
  InventoryRow,
  MovementRow,
  NetworkConfig,
  OrderListItem,
  OutboundOrderInput,
  Partner,
  Product,
  ProfitRow,
  Sku
} from "../shared/types";

type StockLot = {
  id: number;
  skuId: number;
  inboundOrderId: number;
  stockLocation?: "warehouse" | "storefront";
  remainingQuantity: number;
  unitCost: number;
  receivedAt: string;
};

type State = {
  nextId: number;
  users: (AuthUser & { password: string })[];
  products: Product[];
  skus: Sku[];
  partners: Partner[];
  inboundOrders: OrderListItem[];
  outboundOrders: OrderListItem[];
  inboundLines: Record<number, InboundOrderInput["lines"]>;
  outboundLines: Record<number, OutboundOrderInput["lines"]>;
  lots: StockLot[];
  movements: MovementRow[];
  backups: BackupInfo[];
};

const STORAGE_KEY = "kucun.devApi.v1";
const NETWORK_STORAGE_KEY = "kucun.devApi.network.v1";
const iso = () => new Date().toISOString();
const date = () => iso().slice(0, 10);
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function id(state: State) {
  state.nextId += 1;
  return state.nextId;
}

function orderNo(prefix: "IN" | "OUT") {
  return `${prefix}${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${Math.floor(Math.random() * 9000 + 1000)}`;
}

function initialState(): State {
  const now = iso();
  const products: Product[] = [
    {
      id: 1,
      name: "示例T恤",
      code: "P001",
      category: "服装",
      note: "浏览器预览数据",
      isActive: true,
      createdAt: now,
      updatedAt: now
    }
  ];
  const skus: Sku[] = [
    {
      id: 2,
      productId: 1,
      productName: "示例T恤",
      name: "白色 / L",
      skuCode: "TS-W-L",
      barcode: null,
      unit: "件",
      defaultCost: 38,
      defaultPrice: 99,
      lowStockThreshold: 5,
      isActive: true,
      currentStock: 0,
      createdAt: now,
      updatedAt: now
    }
  ];
  const partners: Partner[] = [
    {
      id: 3,
      type: "supplier",
      name: "示例供应商",
      contact: "张三",
      phone: "",
      address: "",
      note: "",
      isMember: false,
      memberDiscounts: [],
      isActive: true,
      createdAt: now,
      updatedAt: now
    },
    {
      id: 4,
      type: "customer",
      name: "示例客户",
      contact: "李四",
      phone: "",
      address: "",
      note: "",
      isMember: true,
      memberDiscounts: [{ productName: "示例T恤", discountAmount: 10 }],
      isActive: true,
      createdAt: now,
      updatedAt: now
    }
  ];
  return {
    nextId: 4,
    users: [
      {
        id: 100,
        username: "admin",
        password: "admin123",
        role: "admin",
        isActive: true,
        createdAt: now,
        updatedAt: now
      }
    ],
    products,
    skus,
    partners,
    inboundOrders: [],
    outboundOrders: [],
    inboundLines: {},
    outboundLines: {},
    lots: [],
    movements: [],
    backups: []
  };
}

function loadState(): State {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return initialState();
  try {
    const state = JSON.parse(raw) as State;
    state.users = Array.isArray(state.users) && state.users.length ? state.users : initialState().users;
    state.partners = state.partners.map((partner) => ({
      ...partner,
      isMember: partner.type === "customer" && partner.isMember === true,
      memberDiscounts: Array.isArray(partner.memberDiscounts) ? partner.memberDiscounts : []
    }));
    return state;
  } catch {
    return initialState();
  }
}

function saveState(state: State) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadNetworkConfig(): NetworkConfig {
  const raw = window.localStorage.getItem(NETWORK_STORAGE_KEY);
  if (!raw) return { mode: "local", hostPort: 8787, serverUrl: "" };
  try {
    const parsed = JSON.parse(raw) as Partial<NetworkConfig>;
    return {
      mode: parsed.mode === "host" || parsed.mode === "client" ? parsed.mode : "local",
      hostPort: Number(parsed.hostPort || 8787),
      serverUrl: parsed.serverUrl || ""
    };
  } catch {
    return { mode: "local", hostPort: 8787, serverUrl: "" };
  }
}

function saveNetworkConfig(config: NetworkConfig) {
  window.localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(config));
}

function normalizeMemberDiscounts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      productName: String(item?.productName ?? "").trim(),
      discountAmount: Number(item?.discountAmount ?? 0)
    }))
    .filter((item) => item.productName)
    .map((item) => {
      if (!Number.isFinite(item.discountAmount) || item.discountAmount < 0) throw new Error("单件优惠不能小于0");
      return item;
    });
}

function getProductName(state: State, productId: number) {
  return state.products.find((product) => product.id === productId)?.name ?? "";
}

function isProductDeleted(state: State, productId: number) {
  return Boolean(state.products.find((product) => product.id === productId)?.deletedAt);
}

function getSku(state: State, skuId: number) {
  const sku = state.skus.find((item) => item.id === skuId);
  if (!sku) throw new Error("SKU不存在");
  return { ...sku, productName: getProductName(state, sku.productId) };
}

function currentStock(state: State, skuId: number) {
  return money(state.lots.filter((lot) => lot.skuId === skuId).reduce((sum, lot) => sum + lot.remainingQuantity, 0));
}

function locationStock(state: State, skuId: number, stockLocation: "warehouse" | "storefront") {
  return money(
    state.lots
      .filter((lot) => lot.skuId === skuId && (lot.stockLocation ?? "warehouse") === stockLocation)
      .reduce((sum, lot) => sum + lot.remainingQuantity, 0)
  );
}

function stockValue(state: State, skuId: number) {
  return money(state.lots.filter((lot) => lot.skuId === skuId).reduce((sum, lot) => sum + lot.remainingQuantity * lot.unitCost, 0));
}

function makeCatalog(state: State): CatalogPayload {
  const skus = state.skus
    .filter((sku) => !sku.deletedAt && !isProductDeleted(state, sku.productId))
    .map((sku) => ({
      ...sku,
      productName: getProductName(state, sku.productId),
      currentStock: currentStock(state, sku.id)
    }));
  return {
    products: state.products.filter((product) => !product.deletedAt),
    skus,
    suppliers: state.partners.filter((partner) => partner.type === "supplier"),
    customers: state.partners.filter((partner) => partner.type === "customer")
  };
}

function makeInventory(state: State): InventoryRow[] {
  return state.skus
    .filter((sku) => sku.isActive && !sku.deletedAt && !isProductDeleted(state, sku.productId))
    .map((sku) => {
      const stock = currentStock(state, sku.id);
      const storefrontStock = locationStock(state, sku.id, "storefront");
      return {
        skuId: sku.id,
        productName: getProductName(state, sku.productId),
        skuName: sku.name,
        skuCode: sku.skuCode,
        unit: sku.unit,
        defaultCost: sku.defaultCost,
        defaultPrice: sku.defaultPrice,
        lowStockThreshold: sku.lowStockThreshold,
        warehouseStock: locationStock(state, sku.id, "warehouse"),
        storefrontStock,
        currentStock: stock,
        stockValue: stockValue(state, sku.id),
        isLowStock: storefrontStock <= sku.lowStockThreshold
      };
    });
}

function createDevApi(): AppApi {
  const state = loadState();
  let networkConfig = loadNetworkConfig();

  const persist = <T>(value: T) => {
    saveState(state);
    return Promise.resolve(value);
  };

  const api: AppApi = {
    login: async (input) => {
      const user = state.users.find((item) => item.username === input.username && item.password === input.password && item.isActive);
      if (!user) throw new Error("用户名或密码不正确");
      const { password: _password, ...safeUser } = user;
      return safeUser;
    },
    listUsers: async () => state.users.map(({ password: _password, ...user }) => user),
    createUser: (input) => {
      const now = iso();
      const username = String(input.username ?? "").trim();
      const password = String(input.password ?? "").trim();
      if (!username) throw new Error("用户名不能为空");
      if (!password) throw new Error("密码不能为空");
      if (state.users.some((user) => user.username === username)) throw new Error("用户名已存在");
      const user = {
        id: id(state),
        username,
        password,
        role: input.role === "storefront" || input.role === "warehouse" ? input.role : "admin",
        isActive: input.isActive !== false,
        createdAt: now,
        updatedAt: now
      } satisfies AuthUser & { password: string };
      state.users.push(user);
      const { password: _password, ...safeUser } = user;
      return persist(safeUser);
    },
    updateUser: (userId, input) => {
      const user = state.users.find((item) => item.id === userId);
      if (!user) throw new Error("账号不存在");
      user.username = String(input.username ?? "").trim();
      user.role = input.role === "storefront" || input.role === "warehouse" ? input.role : "admin";
      user.isActive = input.isActive !== false;
      if (input.password) user.password = input.password;
      user.updatedAt = iso();
      const { password: _password, ...safeUser } = user;
      return persist(safeUser);
    },
    deleteUser: (userId) => {
      const user = state.users.find((item) => item.id === userId);
      if (!user) throw new Error("账号不存在");
      if (user.role === "admin" && state.users.filter((item) => item.role === "admin" && item.isActive && item.id !== userId).length === 0) {
        throw new Error("至少保留一个启用的管理员账号");
      }
      state.users = state.users.filter((item) => item.id !== userId);
      return persist(undefined);
    },
    getCatalog: async () => makeCatalog(state),
    createProduct: (input) => {
      const now = iso();
      const product: Product = {
        id: id(state),
        name: String(input.name ?? "").trim(),
        code: input.code ?? null,
        category: input.category ?? null,
        note: input.note ?? null,
        isActive: input.isActive !== false,
        createdAt: now,
        updatedAt: now
      };
      if (!product.name) throw new Error("商品名称不能为空");
      state.products.push(product);
      return persist(product);
    },
    updateProduct: (productId, input) => {
      const product = state.products.find((item) => item.id === productId);
      if (!product) throw new Error("商品不存在");
      Object.assign(product, input, { updatedAt: iso() });
      return persist(product);
    },
    deleteProduct: (productId) => {
      const product = state.products.find((item) => item.id === productId);
      if (!product) throw new Error("商品不存在");
      const hasSku = state.skus.some((sku) => sku.productId === productId);
      if (hasSku) {
        const now = iso();
        product.isActive = false;
        product.deletedAt = now;
        product.updatedAt = now;
        for (const sku of state.skus.filter((item) => item.productId === productId)) {
          sku.isActive = false;
          sku.deletedAt = now;
          sku.updatedAt = now;
        }
        return persist(undefined);
      }
      const before = state.products.length;
      state.products = state.products.filter((product) => product.id !== productId);
      if (state.products.length === before) throw new Error("商品不存在");
      return persist(undefined);
    },
    createSku: (input) => {
      const now = iso();
      const sku: Sku = {
        id: id(state),
        productId: Number(input.productId),
        productName: getProductName(state, Number(input.productId)),
        name: String(input.name ?? "").trim(),
        skuCode: input.skuCode ?? null,
        barcode: input.barcode ?? null,
        unit: input.unit || "件",
        defaultCost: Number(input.defaultCost ?? 0),
        defaultPrice: Number(input.defaultPrice ?? 0),
        lowStockThreshold: Number(input.lowStockThreshold ?? 0),
        isActive: input.isActive !== false,
        currentStock: 0,
        createdAt: now,
        updatedAt: now
      };
      if (!sku.productId) throw new Error("请选择商品");
      if (!sku.name) throw new Error("SKU名称不能为空");
      state.skus.push(sku);
      return persist(sku);
    },
    updateSku: (skuId, input) => {
      const sku = state.skus.find((item) => item.id === skuId);
      if (!sku) throw new Error("SKU不存在");
      Object.assign(sku, input, {
        productId: Number(input.productId),
        defaultCost: Number(input.defaultCost ?? 0),
        defaultPrice: Number(input.defaultPrice ?? 0),
        lowStockThreshold: Number(input.lowStockThreshold ?? 0),
        updatedAt: iso()
      });
      return persist(sku);
    },
    deleteSku: (skuId) => {
      const inboundCount = Object.values(state.inboundLines).flat().filter((line) => line.skuId === skuId).length;
      const outboundCount = Object.values(state.outboundLines).flat().filter((line) => line.skuId === skuId).length;
      const lotCount = state.lots.filter((lot) => lot.skuId === skuId).length;
      const movementCount = state.movements.filter((movement) => movement.skuId === skuId).length;
      if (inboundCount + outboundCount + lotCount + movementCount > 0) {
        const sku = state.skus.find((item) => item.id === skuId);
        if (!sku) throw new Error("SKU不存在");
        sku.isActive = false;
        sku.deletedAt = iso();
        sku.updatedAt = sku.deletedAt;
        return persist(undefined);
      }
      const before = state.skus.length;
      state.skus = state.skus.filter((sku) => sku.id !== skuId);
      if (state.skus.length === before) throw new Error("SKU不存在");
      return persist(undefined);
    },
    createPartner: (input) => {
      const now = iso();
      const type = input.type === "customer" ? "customer" : "supplier";
      const partner: Partner = {
        id: id(state),
        type,
        name: String(input.name ?? "").trim(),
        contact: input.contact ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        note: input.note ?? null,
        isMember: type === "customer" && input.isMember === true,
        memberDiscounts: type === "customer" ? normalizeMemberDiscounts(input.memberDiscounts) : [],
        isActive: input.isActive !== false,
        createdAt: now,
        updatedAt: now
      };
      if (!partner.name) throw new Error("名称不能为空");
      state.partners.push(partner);
      return persist(partner);
    },
    updatePartner: (partnerId, input) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      if (!partner) throw new Error("往来单位不存在");
      const type = input.type === "customer" ? "customer" : "supplier";
      Object.assign(partner, input, {
        type,
        isMember: type === "customer" && input.isMember === true,
        memberDiscounts: type === "customer" ? normalizeMemberDiscounts(input.memberDiscounts) : [],
        updatedAt: iso()
      });
      return persist(partner);
    },
    deletePartner: (partnerId) => {
      const inboundCount = state.inboundOrders.filter((order) => order.partnerId === partnerId).length;
      const outboundCount = state.outboundOrders.filter((order) => order.partnerId === partnerId).length;
      if (inboundCount + outboundCount > 0) {
        throw new Error("该客户或供应商已有单据记录，不能删除。可以将其停用，历史单据会保留。");
      }
      const before = state.partners.length;
      state.partners = state.partners.filter((partner) => partner.id !== partnerId);
      if (state.partners.length === before) throw new Error("往来单位不存在");
      return persist(undefined);
    },
    listInboundOrders: async () => [...state.inboundOrders].reverse(),
    createInboundOrder: (input) => {
      if (!input.lines.length) throw new Error("请至少添加一条入库明细");
      const totalAmount = money(input.lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0));
      const order: OrderListItem = {
        id: id(state),
        orderNo: orderNo("IN"),
        status: "draft",
        partnerName: state.partners.find((partner) => partner.id === input.supplierId)?.name ?? null,
        orderDate: input.orderDate || date(),
        totalAmount,
        totalCost: 0,
        totalProfit: 0,
        note: input.note ?? null,
        createdAt: iso(),
        approvedAt: null,
        voidedAt: null
      };
      state.inboundOrders.push(order);
      state.inboundLines[order.id] = input.lines;
      return persist(order);
    },
    approveInboundOrder: (orderId) => {
      const order = state.inboundOrders.find((item) => item.id === orderId);
      if (!order) throw new Error("入库单不存在");
      if (order.status !== "draft") throw new Error("只有草稿入库单可以审核");
      const approvedAt = iso();
      for (const line of state.inboundLines[orderId] ?? []) {
        const lotId = id(state);
        state.lots.push({
          id: lotId,
          skuId: line.skuId,
          inboundOrderId: orderId,
          stockLocation: "warehouse",
          remainingQuantity: line.quantity,
          unitCost: line.unitCost,
          receivedAt: order.orderDate
        });
        const sku = getSku(state, line.skuId);
        state.movements.push({
          id: id(state),
          skuId: line.skuId,
          productName: sku.productName ?? "",
          skuName: sku.name,
          type: "in",
          quantity: line.quantity,
          unitCost: line.unitCost,
          unitPrice: null,
          costAmount: money(line.quantity * line.unitCost),
          salesAmount: 0,
          profitAmount: 0,
          orderType: "inbound",
          orderNo: order.orderNo,
          note: line.note ?? null,
          occurredAt: approvedAt
        });
      }
      order.status = "approved";
      order.approvedAt = approvedAt;
      return persist(undefined);
    },
    voidInboundOrder: (orderId) => {
      const order = state.inboundOrders.find((item) => item.id === orderId);
      if (!order) throw new Error("入库单不存在");
      if (order.status === "approved") {
        const lots = state.lots.filter((lot) => lot.inboundOrderId === orderId);
        const consumed = lots.some((lot) => {
          const line = state.inboundLines[orderId]?.find((item) => item.skuId === lot.skuId);
          return line && lot.remainingQuantity < line.quantity;
        });
        if (consumed) throw new Error("该入库批次已有出库记录，不能直接作废");
        state.lots = state.lots.filter((lot) => lot.inboundOrderId !== orderId);
        state.movements = state.movements.filter((movement) => movement.orderNo !== order.orderNo);
      }
      order.status = "voided";
      order.voidedAt = iso();
      return persist(undefined);
    },
    listOutboundOrders: async () => [...state.outboundOrders].reverse(),
    createOutboundOrder: (input) => {
      if (!input.lines.length) throw new Error("请至少添加一条出库明细");
      const totalAmount = money(input.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0));
      const order: OrderListItem = {
        id: id(state),
        orderNo: orderNo("OUT"),
        status: "draft",
        partnerName: state.partners.find((partner) => partner.id === input.customerId)?.name ?? null,
        orderDate: input.orderDate || date(),
        totalAmount,
        totalCost: 0,
        totalProfit: 0,
        note: input.note ?? null,
        createdAt: iso(),
        approvedAt: null,
        voidedAt: null
      };
      state.outboundOrders.push(order);
      state.outboundLines[order.id] = input.lines;
      return persist(order);
    },
    approveOutboundOrder: (orderId) => {
      const order = state.outboundOrders.find((item) => item.id === orderId);
      if (!order) throw new Error("出库单不存在");
      if (order.status !== "draft") throw new Error("只有草稿出库单可以审核");
      const lines = state.outboundLines[orderId] ?? [];
      for (const line of lines) {
        if (locationStock(state, line.skuId, "storefront") < line.quantity) throw new Error(`${getSku(state, line.skuId).name} 门市库存不足`);
      }
      let totalCost = 0;
      const approvedAt = iso();
      for (const line of lines) {
        let remaining = line.quantity;
        const lots = state.lots
          .filter((lot) => lot.skuId === line.skuId && (lot.stockLocation ?? "warehouse") === "storefront" && lot.remainingQuantity > 0)
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id - b.id);
        for (const lot of lots) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, lot.remainingQuantity);
          const costAmount = money(take * lot.unitCost);
          const salesAmount = money(take * line.unitPrice);
          lot.remainingQuantity = money(lot.remainingQuantity - take);
          totalCost = money(totalCost + costAmount);
          const sku = getSku(state, line.skuId);
          state.movements.push({
            id: id(state),
            skuId: line.skuId,
            productName: sku.productName ?? "",
            skuName: sku.name,
            type: "out",
            quantity: -take,
            unitCost: lot.unitCost,
            unitPrice: line.unitPrice,
            costAmount,
            salesAmount,
            profitAmount: money(salesAmount - costAmount),
            orderType: "outbound",
            orderNo: order.orderNo,
            note: line.note ?? null,
            occurredAt: approvedAt
          });
          remaining = money(remaining - take);
        }
      }
      order.status = "approved";
      order.approvedAt = approvedAt;
      order.totalCost = totalCost;
      order.totalProfit = money(order.totalAmount - totalCost);
      return persist(undefined);
    },
    voidOutboundOrder: (orderId) => {
      const order = state.outboundOrders.find((item) => item.id === orderId);
      if (!order) throw new Error("出库单不存在");
      order.status = "voided";
      order.voidedAt = iso();
      return persist(undefined);
    },
    transferToStorefront: (input) => {
      const skuId = Number(input.skuId);
      const transferQty = Number(input.quantity);
      if (!skuId || !transferQty || transferQty <= 0) throw new Error("请选择SKU并填写调拨数量");
      if (locationStock(state, skuId, "warehouse") < transferQty) throw new Error(`${getSku(state, skuId).name} 仓库库存不足`);
      let remaining = transferQty;
      const lots = state.lots
        .filter((lot) => lot.skuId === skuId && (lot.stockLocation ?? "warehouse") === "warehouse" && lot.remainingQuantity > 0)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id - b.id);
      const occurredAt = iso();
      for (const lot of lots) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, lot.remainingQuantity);
        lot.remainingQuantity = money(lot.remainingQuantity - take);
        state.lots.push({
          id: id(state),
          skuId,
          inboundOrderId: lot.inboundOrderId,
          stockLocation: "storefront",
          remainingQuantity: take,
          unitCost: lot.unitCost,
          receivedAt: lot.receivedAt
        });
        const sku = getSku(state, skuId);
        state.movements.push({
          id: id(state),
          skuId,
          productName: sku.productName ?? "",
          skuName: sku.name,
          type: "out",
          quantity: -take,
          unitCost: lot.unitCost,
          unitPrice: null,
          costAmount: money(take * lot.unitCost),
          salesAmount: 0,
          profitAmount: 0,
          orderType: "transfer",
          orderNo: "仓库到门市",
          note: input.note ?? null,
          occurredAt
        });
        state.movements.push({
          id: id(state),
          skuId,
          productName: sku.productName ?? "",
          skuName: sku.name,
          type: "in",
          quantity: take,
          unitCost: lot.unitCost,
          unitPrice: null,
          costAmount: money(take * lot.unitCost),
          salesAmount: 0,
          profitAmount: 0,
          orderType: "transfer",
          orderNo: "仓库到门市",
          note: input.note ?? null,
          occurredAt
        });
        remaining = money(remaining - take);
      }
      return persist(undefined);
    },
    addStorefrontStock: (input) => {
      const skuId = Number(input.skuId);
      const quantity = Number(input.quantity);
      const unitCost = Number(input.unitCost);
      if (!skuId || !quantity || quantity <= 0 || !unitCost || unitCost <= 0) throw new Error("请选择SKU，并填写数量和成本价");
      const sku = getSku(state, skuId);
      const occurredAt = iso();
      state.lots.push({
        id: id(state),
        skuId,
        inboundOrderId: 0,
        stockLocation: "storefront",
        remainingQuantity: quantity,
        unitCost,
        receivedAt: occurredAt.slice(0, 10)
      });
      state.movements.push({
        id: id(state),
        skuId,
        productName: sku.productName ?? "",
        skuName: sku.name,
        type: "in",
        quantity,
        unitCost,
        unitPrice: null,
        costAmount: money(quantity * unitCost),
        salesAmount: 0,
        profitAmount: 0,
        orderType: "storefront_increase",
        orderNo: "门市加库存",
        note: input.note ?? null,
        occurredAt
      });
      return persist(undefined);
    },
    listPrinters: async () => [
      {
        name: "browser-preview",
        displayName: "浏览器预览打印机",
        isDefault: true,
        status: 0
      }
    ],
    printOutboundReceipt: async (orderId, options) => {
      const order = state.outboundOrders.find((item) => item.id === orderId);
      if (!order) throw new Error("出库单不存在");
      if (options?.approveAfterPrint) {
        await api.approveOutboundOrder(orderId);
      }
      saveState(state);
    },
    getInventory: async () => makeInventory(state),
    getDashboard: async () => {
      const inventory = makeInventory(state);
      const approvedOut = state.outboundOrders.filter((order) => order.status === "approved");
      return {
        skuCount: inventory.length,
        totalStock: money(inventory.reduce((sum, row) => sum + row.currentStock, 0)),
        stockValue: money(inventory.reduce((sum, row) => sum + row.stockValue, 0)),
        lowStockCount: inventory.filter((row) => row.isLowStock).length,
        salesAmount: money(approvedOut.reduce((sum, order) => sum + order.totalAmount, 0)),
        profitAmount: money(approvedOut.reduce((sum, order) => sum + (order.totalProfit ?? 0), 0))
      } satisfies Dashboard;
    },
    getMovements: async () => [...state.movements].reverse(),
    getProfitReport: async () => {
      const rows = new Map<number, ProfitRow>();
      for (const movement of state.movements.filter((item) => item.type === "out")) {
        const existing = rows.get(movement.skuId) ?? {
          skuId: movement.skuId,
          productName: movement.productName,
          skuName: movement.skuName,
          quantity: 0,
          salesAmount: 0,
          costAmount: 0,
          profitAmount: 0
        };
        existing.quantity = money(existing.quantity + Math.abs(movement.quantity));
        existing.salesAmount = money(existing.salesAmount + movement.salesAmount);
        existing.costAmount = money(existing.costAmount + movement.costAmount);
        existing.profitAmount = money(existing.profitAmount + movement.profitAmount);
        rows.set(movement.skuId, existing);
      }
      return [...rows.values()];
    },
    exportExcel: async () => "浏览器预览模式不会生成真实Excel文件，请在桌面应用中导出。",
    createBackup: () => {
      const backup: BackupInfo = {
        fileName: `browser-preview-${iso()}.json`,
        fullPath: "localStorage",
        size: JSON.stringify(state).length,
        createdAt: iso()
      };
      state.backups.push(backup);
      return persist(backup.fileName);
    },
    listBackups: async () => [...state.backups].reverse(),
    revealPath: async () => undefined,
    getNetworkStatus: async () => ({
      config: networkConfig,
      serverRunning: networkConfig.mode === "host",
      lanUrls: networkConfig.mode === "host" ? [`http://127.0.0.1:${networkConfig.hostPort}`, `http://192.168.1.20:${networkConfig.hostPort}`] : []
    }),
    setNetworkConfig: (config) => {
      networkConfig = config;
      saveNetworkConfig(config);
      return Promise.resolve({
        config: networkConfig,
        serverRunning: networkConfig.mode === "host",
        lanUrls: networkConfig.mode === "host" ? [`http://127.0.0.1:${networkConfig.hostPort}`, `http://192.168.1.20:${networkConfig.hostPort}`] : []
      });
    },
    testServerConnection: async (serverUrl) => Boolean(serverUrl.trim())
  };

  return api;
}

export function installDevApi() {
  if (!window.inventoryAPI) {
    window.inventoryAPI = createDevApi();
  }
}
