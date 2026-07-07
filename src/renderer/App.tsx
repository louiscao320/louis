import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Boxes,
  ClipboardList,
  Download,
  Factory,
  FileDown,
  LayoutDashboard,
  PackagePlus,
  PackageX,
  Printer,
  RotateCcw,
  Save,
  Search,
  Store,
  Truck,
  UserPlus,
  Users
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  BackupInfo,
  AuthUser,
  CatalogPayload,
  Dashboard,
  InboundOrderInput,
  InventoryRow,
  MovementRow,
  NetworkConfig,
  NetworkStatus,
  OrderLineInput,
  OrderListItem,
  OutboundOrderInput,
  Partner,
  PrinterInfo,
  Product,
  ProfitRow,
  Sku,
  UserInput
} from "../shared/types";

type ViewKey = "storefront" | "warehouse" | "summary";
type SortDirection = "asc" | "desc";
type DateRange = { startDate: string; endDate: string };
type StoreInventorySortKey = "productName" | "skuName" | "skuCode" | "storefrontStock" | "defaultPrice" | "isLowStock";
type InventorySortKey =
  | "productName"
  | "skuName"
  | "skuCode"
  | "warehouseStock"
  | "storefrontStock"
  | "currentStock"
  | "stockValue"
  | "defaultPrice"
  | "isLowStock";
type JumpItem = { id: string; label: string };
const roleLabels: Record<AuthUser["role"], string> = { admin: "管理员", storefront: "门市", warehouse: "仓库" };

const emptyCatalog: CatalogPayload = { products: [], skus: [], suppliers: [], customers: [] };
const money = (value: number | undefined | null) => `¥${Number(value ?? 0).toFixed(2)}`;
const qty = (value: number | undefined | null) => Number(value ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const memberPrice = (sku: Sku | undefined, customer: Partner | undefined) => {
  const price = Number(sku?.defaultPrice ?? 0);
  if (!sku?.productName || !customer?.isMember) return price;
  const discount = customer.memberDiscounts.find((item) => item.productName.trim() === sku.productName?.trim());
  const discountAmount = Number(discount?.discountAmount ?? 0);
  return Math.max(0, Math.round((price - discountAmount + Number.EPSILON) * 100) / 100);
};
const formatMemberDiscounts = (discounts: Partner["memberDiscounts"] | undefined) =>
  discounts?.length ? discounts.map((item) => `${item.productName} - ${money(item.discountAmount)}/件`).join("；") : "-";

function isDateInRange(value: string | null | undefined, range: DateRange) {
  const date = String(value ?? "").slice(0, 10);
  if (!date) return true;
  if (range.startDate && date < range.startDate) return false;
  if (range.endDate && date > range.endDate) return false;
  return true;
}

function profitRowsFromMovements(rows: MovementRow[]): ProfitRow[] {
  const grouped = new Map<number, ProfitRow>();
  for (const row of rows) {
    if (row.type !== "out") continue;
    const item = grouped.get(row.skuId) ?? {
      skuId: row.skuId,
      productName: row.productName,
      skuName: row.skuName,
      quantity: 0,
      salesAmount: 0,
      costAmount: 0,
      profitAmount: 0
    };
    item.quantity += Math.abs(row.quantity);
    item.salesAmount += row.salesAmount;
    item.costAmount += row.costAmount;
    item.profitAmount += row.profitAmount;
    grouped.set(row.skuId, item);
  }
  return [...grouped.values()].sort((left, right) => right.profitAmount - left.profitAmount);
}

function dashboardForRange(inventory: InventoryRow[], outboundOrders: OrderListItem[], profitRows: ProfitRow[]): Dashboard {
  const approvedOrders = outboundOrders.filter((order) => order.status === "approved");
  return {
    skuCount: inventory.length,
    totalStock: inventory.reduce((sum, row) => sum + row.currentStock, 0),
    stockValue: inventory.reduce((sum, row) => sum + row.stockValue, 0),
    lowStockCount: inventory.filter((row) => row.isLowStock).length,
    salesAmount: approvedOrders.reduce((sum, order) => sum + order.totalAmount, 0),
    profitAmount: profitRows.reduce((sum, row) => sum + row.profitAmount, 0)
  };
}

const views: { key: ViewKey; label: string; subtitle: string; icon: typeof LayoutDashboard }[] = [
  { key: "storefront", label: "门市", subtitle: "销售开单 · 小票打印 · 自动出库", icon: Store },
  { key: "warehouse", label: "仓库", subtitle: "商品SKU · 入库审核 · 库存维护", icon: Boxes },
  { key: "summary", label: "总计", subtitle: "经营汇总 · 利润流水 · 备份导出", icon: LayoutDashboard }
];

const jumpItems: Record<ViewKey, JumpItem[]> = {
  storefront: [
    { id: "storefront-add-stock", label: "门市加库存" },
    { id: "storefront-stock", label: "门市库存" },
    { id: "storefront-members", label: "会员客户" },
    { id: "storefront-sales", label: "门市销售" },
    { id: "storefront-profit", label: "热销利润" }
  ],
  warehouse: [
    { id: "warehouse-transfer", label: "调拨到门市" },
    { id: "warehouse-inbound", label: "仓库入库" },
    { id: "warehouse-catalog", label: "商品与SKU" },
    { id: "warehouse-partners", label: "客户供应商" },
    { id: "warehouse-stock", label: "库存现状" }
  ],
  summary: [
    { id: "summary-dashboard", label: "经营总计" },
    { id: "summary-inventory", label: "合计库存现状" },
    { id: "summary-profit", label: "利润总计" },
    { id: "summary-movements", label: "出入库总流水" },
    { id: "summary-users", label: "账号权限" },
    { id: "summary-network", label: "门市仓库联机" },
    { id: "summary-backup", label: "导出与备份" }
  ]
};

function App() {
  const [activeView, setActiveView] = useState<ViewKey>("storefront");
  const [catalog, setCatalog] = useState<CatalogPayload>(emptyCatalog);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [profit, setProfit] = useState<ProfitRow[]>([]);
  const [inboundOrders, setInboundOrders] = useState<OrderListItem[]>([]);
  const [outboundOrders, setOutboundOrders] = useState<OrderListItem[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>({ startDate: "", endDate: "" });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
    try {
      setError("");
      const result = await action();
      if (success) setNotice(success);
      return result;
    } catch (err) {
      setNotice("");
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async function refreshAll() {
    setLoading(true);
    await run(async () => {
      const [catalogData, dashboardData, inventoryData, movementData, profitData, inboundData, outboundData, backupData, networkData] =
        await Promise.all([
          window.inventoryAPI.getCatalog(),
          window.inventoryAPI.getDashboard(),
          window.inventoryAPI.getInventory(),
          window.inventoryAPI.getMovements(),
          window.inventoryAPI.getProfitReport(),
          window.inventoryAPI.listInboundOrders(),
          window.inventoryAPI.listOutboundOrders(),
          window.inventoryAPI.listBackups(),
          window.inventoryAPI.getNetworkStatus()
        ]);
      setCatalog(catalogData);
      setDashboard(dashboardData);
      setInventory(inventoryData);
      setMovements(movementData);
      setProfit(profitData);
      setInboundOrders(inboundData);
      setOutboundOrders(outboundData);
      setBackups(backupData);
      setNetworkStatus(networkData);
    });
    setLoading(false);
  }

  const allowedViews = useMemo(() => {
    if (!currentUser) return [];
    if (currentUser.role === "admin") return views;
    return views.filter((view) => view.key === currentUser.role);
  }, [currentUser]);
  const currentViewKey = allowedViews.some((view) => view.key === activeView) ? activeView : allowedViews[0]?.key ?? "storefront";

  useEffect(() => {
    if (!currentUser) return;
    const nextView = currentUser.role === "admin" ? activeView : currentUser.role;
    setActiveView(nextView);
    void refreshAll();
  }, [currentUser]);

  const content = useMemo(() => {
    const props = { catalog, refreshAll, run };
    const filteredInboundOrders = inboundOrders.filter((order) => isDateInRange(order.orderDate, dateRange));
    const filteredOutboundOrders = outboundOrders.filter((order) => isDateInRange(order.orderDate, dateRange));
    const filteredMovements = movements.filter((movement) => isDateInRange(movement.occurredAt, dateRange));
    const filteredProfit = profitRowsFromMovements(filteredMovements);
    const filteredDashboard = dashboardForRange(inventory, filteredOutboundOrders, filteredProfit);
    if (currentViewKey === "storefront") {
      return (
        <StorefrontView
          {...props}
          dateRange={dateRange}
          setDateRange={setDateRange}
          dashboard={filteredDashboard}
          inventory={inventory}
          profit={filteredProfit}
          outboundOrders={filteredOutboundOrders}
        />
      );
    }
    if (currentViewKey === "warehouse") {
      return <WarehouseView {...props} dateRange={dateRange} setDateRange={setDateRange} inventory={inventory} inboundOrders={filteredInboundOrders} />;
    }
    return (
      <SummaryView
        dateRange={dateRange}
        setDateRange={setDateRange}
        dashboard={filteredDashboard}
        inventory={inventory}
        profit={filteredProfit}
        movements={filteredMovements}
        backups={backups}
        networkStatus={networkStatus}
        currentUser={currentUser}
        refreshAll={refreshAll}
        run={run}
      />
    );
  }, [currentViewKey, backups, catalog, dashboard, dateRange, inboundOrders, inventory, movements, networkStatus, outboundOrders, profit, currentUser]);

  async function login(username: string, password: string) {
    const user = await run(() => window.inventoryAPI.login({ username, password }), "登录成功");
    if (user) setCurrentUser(user);
  }

  function logout() {
    setCurrentUser(null);
    setNotice("");
    setError("");
  }

  if (!currentUser) {
    return <LoginView onLogin={login} error={error} />;
  }

  const currentView = allowedViews.find((view) => view.key === currentViewKey) ?? allowedViews[0] ?? views[0];
  const currentJumpItems = jumpItems[currentView.key];

  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Truck size={28} />
          <div>
            <h1>库存管理</h1>
            <p>本地批次成本版</p>
          </div>
        </div>
        <nav>
          {allowedViews.map((view) => {
            const Icon = view.icon;
            return (
              <button key={view.key} className={activeView === view.key ? "active" : ""} onClick={() => setActiveView(view.key)}>
                <Icon size={18} />
                <span>{view.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="jump-panel">
          <strong>当前页面</strong>
          <div className="jump-list">
            {currentJumpItems.map((item) => (
              <button key={item.id} type="button" onClick={() => jumpTo(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">单仓库 · FIFO批次成本 · 本地SQLite</p>
            <h2>{currentView.label}</h2>
            <p className="view-subtitle">{currentView.subtitle}</p>
          </div>
          <div className="topbar-actions">
            <button className="ghost" onClick={() => void refreshAll()} title="刷新">
              <RotateCcw size={17} />
              刷新
            </button>
            <button className="ghost" onClick={logout} title="退出登录">
              {currentUser.username} · {roleLabels[currentUser.role]} · 退出
            </button>
          </div>
        </header>
        {notice && <div className="notice success">{notice}</div>}
        {error && <div className="notice error">{error}</div>}
        {loading ? <div className="empty">正在读取本地库存数据...</div> : content}
      </main>
    </div>
  );
}

function LoginView({ onLogin, error }: { onLogin: (username: string, password: string) => Promise<void>; error: string }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin123");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onLogin(username, password);
  }

  return (
    <main className="login-screen">
      <form className="panel login-panel" onSubmit={submit}>
        <div className="login-brand">
          <Truck size={30} />
          <div>
            <h1>库存管理</h1>
            <p>请输入账号密码</p>
          </div>
        </div>
        <TextInput label="用户名" value={username} onChange={setUsername} required />
        <TextInput label="密码" type="password" value={password} onChange={setPassword} required />
        {error && <div className="auth-error">{error}</div>}
        <button type="submit">登录</button>
        <p className="login-hint">首次使用：管理员 admin，密码 admin123</p>
      </form>
    </main>
  );
}

function StorefrontView({
  catalog,
  refreshAll,
  run,
  dateRange,
  setDateRange,
  dashboard,
  inventory,
  profit,
  outboundOrders
}: {
  catalog: CatalogPayload;
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  dashboard: Dashboard | null;
  inventory: InventoryRow[];
  profit: ProfitRow[];
  outboundOrders: OrderListItem[];
}) {
  return (
    <section className="stack">
      <DateRangeBar range={dateRange} onChange={setDateRange} />
      <div className="metrics">
        <Metric label="累计销售额" value={money(dashboard?.salesAmount)} />
        <Metric label="累计利润" value={money(dashboard?.profitAmount)} />
        <Metric label="SKU数量" value={dashboard?.skuCount ?? 0} />
        <Metric label="低库存SKU" value={dashboard?.lowStockCount ?? 0} />
      </div>
      <SectionTitle id="storefront-add-stock" icon={PackagePlus} title="门市加库存" />
      <StorefrontStockIncreaseView catalog={catalog} inventory={inventory} refreshAll={refreshAll} run={run} />
      <SectionTitle id="storefront-stock" icon={Archive} title="门市库存" />
      <StoreInventoryView rows={inventory} />
      <SectionTitle id="storefront-members" icon={UserPlus} title="会员客户" />
      <MemberCustomersView customers={catalog.customers} refreshAll={refreshAll} run={run} />
      <SectionTitle id="storefront-sales" icon={PackageX} title="门市销售" />
      <OutboundView catalog={catalog} orders={outboundOrders} refreshAll={refreshAll} run={run} />
      <SectionTitle id="storefront-profit" icon={Factory} title="热销利润" />
      <ProfitView rows={profit.slice(0, 8)} />
    </section>
  );
}

function WarehouseView({
  catalog,
  refreshAll,
  run,
  dateRange,
  setDateRange,
  inventory,
  inboundOrders
}: {
  catalog: CatalogPayload;
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  inventory: InventoryRow[];
  inboundOrders: OrderListItem[];
}) {
  const lowStockRows = inventory.filter((row) => row.isLowStock);
  return (
    <section className="stack">
      <DateRangeBar range={dateRange} onChange={setDateRange} />
      <div className="metrics">
        <Metric label="仓库库存" value={qty(inventory.reduce((sum, row) => sum + row.warehouseStock, 0))} />
        <Metric label="门市库存" value={qty(inventory.reduce((sum, row) => sum + row.storefrontStock, 0))} />
        <Metric label="库存成本" value={money(inventory.reduce((sum, row) => sum + row.stockValue, 0))} />
        <Metric label="低库存SKU" value={lowStockRows.length} />
      </div>
      <SectionTitle id="warehouse-transfer" icon={Truck} title="调拨到门市" />
      <TransferToStorefrontView catalog={catalog} inventory={inventory} refreshAll={refreshAll} run={run} />
      <SectionTitle id="warehouse-inbound" icon={PackagePlus} title="仓库入库" />
      <InboundView catalog={catalog} orders={inboundOrders} refreshAll={refreshAll} run={run} />
      <SectionTitle id="warehouse-catalog" icon={Boxes} title="商品与SKU" />
      <CatalogView catalog={catalog} refreshAll={refreshAll} run={run} />
      <SectionTitle id="warehouse-partners" icon={Users} title="客户供应商" />
      <PartnersView catalog={catalog} refreshAll={refreshAll} run={run} />
      <SectionTitle id="warehouse-stock" icon={Archive} title="库存现状" />
      <InventoryView rows={inventory} />
    </section>
  );
}

function SummaryView({
  dateRange,
  setDateRange,
  dashboard,
  inventory,
  profit,
  movements,
  backups,
  networkStatus,
  currentUser,
  refreshAll,
  run
}: {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  dashboard: Dashboard | null;
  inventory: InventoryRow[];
  profit: ProfitRow[];
  movements: MovementRow[];
  backups: BackupInfo[];
  networkStatus: NetworkStatus | null;
  currentUser: AuthUser | null;
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  return (
    <section className="stack">
      <DateRangeBar range={dateRange} onChange={setDateRange} />
      <SectionTitle id="summary-dashboard" icon={LayoutDashboard} title="经营总计" />
      <DashboardView dashboard={dashboard} inventory={inventory} profit={profit} />
      <SectionTitle id="summary-inventory" icon={Archive} title="合计库存现状" />
      <InventoryView rows={inventory} title="门市+仓库合计库存" />
      <SectionTitle id="summary-profit" icon={Factory} title="利润总计" />
      <ProfitView rows={profit} />
      <SectionTitle id="summary-movements" icon={ClipboardList} title="出入库总流水" />
      <MovementsView rows={movements} />
      {currentUser?.role === "admin" && (
        <>
          <SectionTitle id="summary-users" icon={Users} title="账号权限" />
          <UserManagementView run={run} />
        </>
      )}
      <SectionTitle id="summary-network" icon={Truck} title="门市仓库联机" />
      <NetworkSettingsView status={networkStatus} refreshAll={refreshAll} run={run} />
      <SectionTitle id="summary-backup" icon={Download} title="导出与备份" />
      <BackupView backups={backups} refreshAll={refreshAll} run={run} />
    </section>
  );
}

function UserManagementView({ run }: { run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined> }) {
  type UserForm = UserInput & { id?: number };
  const emptyForm: UserForm = { username: "", password: "", role: "storefront", isActive: true };
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [form, setForm] = useState<UserForm>(emptyForm);

  async function loadUsers() {
    const nextUsers = await run(() => window.inventoryAPI.listUsers());
    if (nextUsers) setUsers(nextUsers);
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const payload: UserInput = {
      username: form.username,
      password: String(form.password ?? ""),
      role: form.role,
      isActive: form.isActive !== false
    };
    const saved = form.id
      ? await run(() => window.inventoryAPI.updateUser(form.id!, payload), "账号已保存")
      : await run(() => window.inventoryAPI.createUser(payload), "账号已新增");
    if (saved) {
      setForm(emptyForm);
      await loadUsers();
    }
  }

  async function deleteUser(id: number) {
    if (!window.confirm("确定删除这个账号吗？至少需要保留一个启用的管理员账号。")) return;
    let deleted = false;
    await run(async () => {
      await window.inventoryAPI.deleteUser(id);
      deleted = true;
    }, "账号已删除");
    if (deleted) await loadUsers();
  }

  return (
    <section className="stack">
      <form className="panel user-form" onSubmit={save}>
        <h3>{form.id ? "编辑账号" : "新增账号"}</h3>
        <TextInput label="用户名" value={form.username} onChange={(username) => setForm({ ...form, username })} required />
        <TextInput
          label={form.id ? "新密码（不填则不改）" : "密码"}
          type="password"
          value={form.password}
          onChange={(password) => setForm({ ...form, password })}
          required={!form.id}
        />
        <Select label="角色权限" value={form.role} onChange={(role) => setForm({ ...form, role: role as AuthUser["role"] })}>
          <option value="admin">管理员</option>
          <option value="storefront">门市</option>
          <option value="warehouse">仓库</option>
        </Select>
        <Check label="启用账号" checked={form.isActive !== false} onChange={(isActive) => setForm({ ...form, isActive })} />
        <button type="submit">
          <Save size={17} />
          {form.id ? "保存账号" : "新增账号"}
        </button>
        {form.id && (
          <button type="button" className="secondary" onClick={() => setForm(emptyForm)}>
            取消编辑
          </button>
        )}
      </form>
      <section className="panel">
        <h3>账号列表</h3>
        <SimpleTable
          headers={["用户名", "角色", "状态", "创建时间", "操作"]}
          rows={users.map((user) => [
            user.username,
            roleLabels[user.role],
            user.isActive ? "启用" : "停用",
            user.createdAt.slice(0, 10),
            <div className="actions-inline">
              <button className="text-button" onClick={() => setForm({ ...user, password: "" })}>
                编辑
              </button>
              <button className="text-button danger" onClick={() => deleteUser(user.id)}>
                删除
              </button>
            </div>
          ])}
          empty="还没有账号"
        />
      </section>
    </section>
  );
}

function DateRangeBar({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  const applyToday = () => onChange({ startDate: today(), endDate: today() });
  const applyMonth = () => onChange({ startDate: monthStart(), endDate: today() });
  const applyAll = () => onChange({ startDate: "", endDate: "" });
  const label = range.startDate || range.endDate ? `${range.startDate || "最早"} 至 ${range.endDate || "今天"}` : "全部日期";

  return (
    <section className="panel date-filter">
      <div>
        <h3>按日期查看</h3>
        <p>{label}</p>
      </div>
      <div className="date-controls">
        <button type="button" className={!range.startDate && !range.endDate ? "active" : ""} onClick={applyAll}>
          全部
        </button>
        <button type="button" className={range.startDate === today() && range.endDate === today() ? "active" : ""} onClick={applyToday}>
          今天
        </button>
        <button type="button" className={range.startDate === monthStart() && range.endDate === today() ? "active" : ""} onClick={applyMonth}>
          本月
        </button>
        <label>
          开始日期
          <input type="date" value={range.startDate} onChange={(event) => onChange({ ...range, startDate: event.target.value })} />
        </label>
        <label>
          结束日期
          <input type="date" value={range.endDate} onChange={(event) => onChange({ ...range, endDate: event.target.value })} />
        </label>
      </div>
    </section>
  );
}

function SectionTitle({ id, icon: Icon, title }: { id?: string; icon: typeof LayoutDashboard; title: string }) {
  return (
    <div id={id} className="section-title">
      <Icon size={18} />
      <h3>{title}</h3>
    </div>
  );
}

function DashboardView({ dashboard, inventory, profit }: { dashboard: Dashboard | null; inventory: InventoryRow[]; profit: ProfitRow[] }) {
  const lowRows = inventory.filter((row) => row.isLowStock);
  const warehouseStock = inventory.reduce((sum, row) => sum + row.warehouseStock, 0);
  const storefrontStock = inventory.reduce((sum, row) => sum + row.storefrontStock, 0);
  const totalStock = warehouseStock + storefrontStock;
  return (
    <section className="stack">
      <div className="metrics">
        <Metric label="SKU数量" value={dashboard?.skuCount ?? 0} />
        <Metric label="仓库库存" value={qty(warehouseStock)} />
        <Metric label="门市库存" value={qty(storefrontStock)} />
        <Metric label="合计总库存" value={qty(totalStock)} />
        <Metric label="库存成本" value={money(dashboard?.stockValue)} />
        <Metric label="累计利润" value={money(dashboard?.profitAmount)} />
      </div>
      <div className="split">
        <section className="panel">
          <h3>低库存提醒</h3>
          <SimpleTable
            headers={["商品", "SKU", "当前", "阈值"]}
            rows={lowRows.map((row) => [row.productName, row.skuName, qty(row.currentStock), qty(row.lowStockThreshold)])}
            empty="暂无低库存SKU"
          />
        </section>
        <section className="panel">
          <h3>利润排行</h3>
          <SimpleTable
            headers={["商品", "SKU", "销量", "利润"]}
            rows={profit.slice(0, 6).map((row) => [row.productName, row.skuName, qty(row.quantity), money(row.profitAmount)])}
            empty="暂无销售利润数据"
          />
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CatalogView({
  catalog,
  refreshAll,
  run
}: {
  catalog: CatalogPayload;
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [productForm, setProductForm] = useState<Partial<Product>>({ name: "", code: "", category: "", note: "", isActive: true });
  const [skuForm, setSkuForm] = useState<Partial<Sku>>({
    productId: catalog.products[0]?.id,
    name: "",
    skuCode: "",
    barcode: "",
    unit: "件",
    defaultCost: 0,
    defaultPrice: 0,
    lowStockThreshold: 0,
    isActive: true
  });
  const [batchSkuForm, setBatchSkuForm] = useState({
    productId: catalog.products[0]?.id,
    patternName: "",
    sizesText: "",
    skuCodePrefix: "",
    unit: "件",
    defaultCost: 0,
    defaultPrice: 0,
    lowStockThreshold: 0
  });
  const [selectedSkuIds, setSelectedSkuIds] = useState<number[]>([]);
  const [batchPriceForm, setBatchPriceForm] = useState({ changeCost: true, defaultCost: 0, changePrice: true, defaultPrice: 0 });

  useEffect(() => {
    if (!skuForm.productId && catalog.products[0]) setSkuForm((form) => ({ ...form, productId: catalog.products[0].id }));
    if (!batchSkuForm.productId && catalog.products[0]) setBatchSkuForm((form) => ({ ...form, productId: catalog.products[0].id }));
    setSelectedSkuIds((ids) => ids.filter((id) => catalog.skus.some((sku) => sku.id === id)));
  }, [catalog.products, skuForm.productId, batchSkuForm.productId]);

  async function saveProduct(event: FormEvent) {
    event.preventDefault();
    await run(
      () => (productForm.id ? window.inventoryAPI.updateProduct(productForm.id, productForm) : window.inventoryAPI.createProduct(productForm)),
      "商品已保存"
    );
    setProductForm({ name: "", code: "", category: "", note: "", isActive: true });
    await refreshAll();
  }

  async function saveSku(event: FormEvent) {
    event.preventDefault();
    await run(() => (skuForm.id ? window.inventoryAPI.updateSku(skuForm.id, skuForm) : window.inventoryAPI.createSku(skuForm)), "SKU已保存");
    setSkuForm({ productId: catalog.products[0]?.id, name: "", skuCode: "", barcode: "", unit: "件", defaultCost: 0, defaultPrice: 0, lowStockThreshold: 0, isActive: true });
    await refreshAll();
  }

  async function saveBatchSkus(event: FormEvent) {
    event.preventDefault();
    const productId = Number(batchSkuForm.productId);
    const patternName = batchSkuForm.patternName.trim();
    const sizes = Array.from(
      new Set(
        batchSkuForm.sizesText
          .split(/[\n,，;；、]+/)
          .map((size) => size.trim())
          .filter(Boolean)
      )
    );
    const existingNames = new Set(catalog.skus.filter((sku) => sku.productId === productId).map((sku) => sku.name.trim()));
    const skuNames = sizes.map((size) => `${patternName}${size}`).filter((name) => !existingNames.has(name));

    const createdCount = await run(async () => {
      if (!productId) throw new Error("请选择商品");
      if (!patternName) throw new Error("请填写花型名");
      if (!sizes.length) throw new Error("请填写至少一个尺寸");
      if (!skuNames.length) throw new Error("这些尺寸已经存在，不需要重复新增");
      for (const name of skuNames) {
        const size = name.slice(patternName.length);
        await window.inventoryAPI.createSku({
          productId,
          name,
          skuCode: batchSkuForm.skuCodePrefix ? `${batchSkuForm.skuCodePrefix}-${size}` : "",
          unit: batchSkuForm.unit || "件",
          defaultCost: batchSkuForm.defaultCost,
          defaultPrice: batchSkuForm.defaultPrice,
          lowStockThreshold: batchSkuForm.lowStockThreshold
        });
      }
      return skuNames.length;
    }, `已新增 ${skuNames.length} 个SKU`);
    if (createdCount) {
      setBatchSkuForm((form) => ({ ...form, patternName: "", sizesText: "", skuCodePrefix: "" }));
      await refreshAll();
    }
  }

  async function deleteSku(id: number) {
    if (!window.confirm("确定删除这个SKU吗？有库存或单据记录的SKU会从列表隐藏，历史账目会保留。")) return;
    let deleted = false;
    await run(async () => {
      await window.inventoryAPI.deleteSku(id);
      deleted = true;
    }, "SKU已删除");
    if (deleted) {
      if (skuForm.id === id) {
        setSkuForm({ productId: catalog.products[0]?.id, name: "", skuCode: "", barcode: "", unit: "件", defaultCost: 0, defaultPrice: 0, lowStockThreshold: 0, isActive: true });
      }
      await refreshAll();
    }
  }

  async function saveBatchPrices(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (!selectedSkuIds.length) throw new Error("请先勾选要修改的SKU");
      if (!batchPriceForm.changeCost && !batchPriceForm.changePrice) throw new Error("请选择要修改成本价或售价");
      for (const id of selectedSkuIds) {
        const sku = catalog.skus.find((item) => item.id === id);
        if (!sku) continue;
        await window.inventoryAPI.updateSku(id, {
          ...sku,
          defaultCost: batchPriceForm.changeCost ? batchPriceForm.defaultCost : sku.defaultCost,
          defaultPrice: batchPriceForm.changePrice ? batchPriceForm.defaultPrice : sku.defaultPrice
        });
      }
    }, `已批量修改 ${selectedSkuIds.length} 个SKU`);
    setSelectedSkuIds([]);
    await refreshAll();
  }

  function toggleSkuSelection(id: number, checked: boolean) {
    setSelectedSkuIds((ids) => (checked ? [...new Set([...ids, id])] : ids.filter((item) => item !== id)));
  }

  async function deleteProduct(id: number) {
    if (!window.confirm("确定删除这个商品吗？商品下的SKU会一起从列表隐藏，历史账目会保留。")) return;
    let deleted = false;
    await run(async () => {
      await window.inventoryAPI.deleteProduct(id);
      deleted = true;
    }, "商品已删除");
    if (deleted) {
      if (productForm.id === id) {
        setProductForm({ name: "", code: "", category: "", note: "", isActive: true });
      }
      await refreshAll();
    }
  }

  return (
    <section className="stack">
      <div className="split">
        <form className="panel form-grid" onSubmit={saveProduct}>
          <h3>{productForm.id ? "编辑商品" : "新增商品"}</h3>
          <TextInput label="商品名称" value={productForm.name} onChange={(name) => setProductForm({ ...productForm, name })} required />
          <TextInput label="商品编码" value={productForm.code} onChange={(code) => setProductForm({ ...productForm, code })} />
          <TextInput label="分类" value={productForm.category} onChange={(category) => setProductForm({ ...productForm, category })} />
          <TextInput label="备注" value={productForm.note} onChange={(note) => setProductForm({ ...productForm, note })} />
          {productForm.id && <Check label="启用" checked={productForm.isActive !== false} onChange={(isActive) => setProductForm({ ...productForm, isActive })} />}
          <SubmitButton label={productForm.id ? "保存商品" : "新增商品"} />
        </form>
        <form className="panel form-grid" onSubmit={saveSku}>
          <h3>{skuForm.id ? "编辑SKU" : "新增SKU"}</h3>
          <Select label="所属商品" value={skuForm.productId ?? ""} onChange={(productId) => setSkuForm({ ...skuForm, productId: Number(productId) })}>
            {catalog.products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </Select>
          <TextInput label="SKU名称" value={skuForm.name} onChange={(name) => setSkuForm({ ...skuForm, name })} required />
          <TextInput label="SKU编码" value={skuForm.skuCode} onChange={(skuCode) => setSkuForm({ ...skuForm, skuCode })} />
          <TextInput label="条码" value={skuForm.barcode} onChange={(barcode) => setSkuForm({ ...skuForm, barcode })} />
          <TextInput label="单位" value={skuForm.unit} onChange={(unit) => setSkuForm({ ...skuForm, unit })} required />
          <NumberInput label="默认成本价" value={skuForm.defaultCost} onChange={(defaultCost) => setSkuForm({ ...skuForm, defaultCost })} />
          <NumberInput label="默认售价" value={skuForm.defaultPrice} onChange={(defaultPrice) => setSkuForm({ ...skuForm, defaultPrice })} />
          <NumberInput label="低库存阈值" value={skuForm.lowStockThreshold} onChange={(lowStockThreshold) => setSkuForm({ ...skuForm, lowStockThreshold })} />
          {skuForm.id && <Check label="启用" checked={skuForm.isActive !== false} onChange={(isActive) => setSkuForm({ ...skuForm, isActive })} />}
          <SubmitButton label={skuForm.id ? "保存SKU" : "新增SKU"} />
        </form>
      </div>
      <form className="panel batch-sku-form" onSubmit={saveBatchSkus}>
        <h3>同花型多尺寸</h3>
        <Select label="所属商品" value={batchSkuForm.productId ?? ""} onChange={(productId) => setBatchSkuForm({ ...batchSkuForm, productId: Number(productId) })}>
          {catalog.products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </Select>
        <TextInput label="花型名" value={batchSkuForm.patternName} onChange={(patternName) => setBatchSkuForm({ ...batchSkuForm, patternName })} required />
        <TextArea label="尺寸列表" value={batchSkuForm.sizesText} onChange={(sizesText) => setBatchSkuForm({ ...batchSkuForm, sizesText })} />
        <TextInput label="编码前缀" value={batchSkuForm.skuCodePrefix} onChange={(skuCodePrefix) => setBatchSkuForm({ ...batchSkuForm, skuCodePrefix })} />
        <TextInput label="单位" value={batchSkuForm.unit} onChange={(unit) => setBatchSkuForm({ ...batchSkuForm, unit })} required />
        <NumberInput label="默认成本价" value={batchSkuForm.defaultCost} onChange={(defaultCost) => setBatchSkuForm({ ...batchSkuForm, defaultCost })} />
        <NumberInput label="默认售价" value={batchSkuForm.defaultPrice} onChange={(defaultPrice) => setBatchSkuForm({ ...batchSkuForm, defaultPrice })} />
        <NumberInput label="低库存阈值" value={batchSkuForm.lowStockThreshold} onChange={(lowStockThreshold) => setBatchSkuForm({ ...batchSkuForm, lowStockThreshold })} />
        <button type="submit">
          <PackagePlus size={17} />
          批量新增SKU
        </button>
      </form>
      <section className="panel">
        <div className="panel-title">
          <h3>SKU列表</h3>
          <form className="batch-price-editor" onSubmit={saveBatchPrices}>
            <Check label="改成本价" checked={batchPriceForm.changeCost} onChange={(changeCost) => setBatchPriceForm({ ...batchPriceForm, changeCost })} />
            <NumberInput label="批量成本价" value={batchPriceForm.defaultCost} onChange={(defaultCost) => setBatchPriceForm({ ...batchPriceForm, defaultCost })} />
            <Check label="改售价" checked={batchPriceForm.changePrice} onChange={(changePrice) => setBatchPriceForm({ ...batchPriceForm, changePrice })} />
            <NumberInput label="批量售价" value={batchPriceForm.defaultPrice} onChange={(defaultPrice) => setBatchPriceForm({ ...batchPriceForm, defaultPrice })} />
            <button type="submit">批量修改</button>
          </form>
        </div>
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={catalog.skus.length > 0 && selectedSkuIds.length === catalog.skus.length}
                  onChange={(event) => setSelectedSkuIds(event.target.checked ? catalog.skus.map((sku) => sku.id) : [])}
                />
              </th>
              <th>商品</th>
              <th>SKU</th>
              <th>编码</th>
              <th>单位</th>
              <th>成本价</th>
              <th>售价</th>
              <th>当前库存</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {catalog.skus.map((sku) => (
              <tr key={sku.id}>
                <td>
                  <input type="checkbox" checked={selectedSkuIds.includes(sku.id)} onChange={(event) => toggleSkuSelection(sku.id, event.target.checked)} />
                </td>
                <td>{sku.productName}</td>
                <td>{sku.name}</td>
                <td>{sku.skuCode || "-"}</td>
                <td>{sku.unit}</td>
                <td>{money(sku.defaultCost)}</td>
                <td>{money(sku.defaultPrice)}</td>
                <td>{qty(sku.currentStock)}</td>
                <td>{sku.isActive ? "启用" : "停用"}</td>
                <td className="right">
                  <div className="actions-inline">
                    <button className="text-button" onClick={() => setSkuForm(sku)}>
                      编辑
                    </button>
                    <button className="text-button danger" onClick={() => deleteSku(sku.id)}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h3>商品列表</h3>
        <SimpleTable
          headers={["名称", "编码", "分类", "状态", "操作"]}
          rows={catalog.products.map((product) => [
            product.name,
            product.code || "-",
            product.category || "-",
            product.isActive ? "启用" : "停用",
            <div className="actions-inline">
              <button className="text-button" onClick={() => setProductForm(product)}>
                编辑
              </button>
              <button className="text-button danger" onClick={() => deleteProduct(product.id)}>
                删除
              </button>
            </div>
          ])}
          empty="还没有商品"
        />
      </section>
    </section>
  );
}

function PartnersView({
  catalog,
  refreshAll,
  run
}: {
  catalog: CatalogPayload;
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [form, setForm] = useState<Partial<Partner>>({
    type: "supplier",
    name: "",
    contact: "",
    phone: "",
    address: "",
    note: "",
    isMember: false,
    memberDiscounts: [],
    isActive: true
  });
  const partners = [...catalog.suppliers, ...catalog.customers];

  async function save(event: FormEvent) {
    event.preventDefault();
    await run(() => (form.id ? window.inventoryAPI.updatePartner(form.id, form) : window.inventoryAPI.createPartner(form)), "往来单位已保存");
    setForm({ type: "supplier", name: "", contact: "", phone: "", address: "", note: "", isMember: false, memberDiscounts: [], isActive: true });
    await refreshAll();
  }

  async function deletePartner(id: number) {
    if (!window.confirm("确定删除这个客户或供应商吗？已有单据记录的单位不能删除。")) return;
    let deleted = false;
    await run(async () => {
      await window.inventoryAPI.deletePartner(id);
      deleted = true;
    }, "往来单位已删除");
    if (deleted) {
      if (form.id === id) {
        setForm({ type: "supplier", name: "", contact: "", phone: "", address: "", note: "", isMember: false, memberDiscounts: [], isActive: true });
      }
      await refreshAll();
    }
  }

  return (
    <section className="stack">
      <form className="panel form-grid wide" onSubmit={save}>
        <h3>{form.id ? "编辑往来单位" : "新增往来单位"}</h3>
        <Select label="类型" value={form.type ?? "supplier"} onChange={(type) => setForm({ ...form, type: type as Partner["type"] })}>
          <option value="supplier">供应商</option>
          <option value="customer">客户</option>
        </Select>
        <TextInput label="名称" value={form.name} onChange={(name) => setForm({ ...form, name })} required />
        <TextInput label="联系人" value={form.contact} onChange={(contact) => setForm({ ...form, contact })} />
        <TextInput label="电话" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
        <TextInput label="地址" value={form.address} onChange={(address) => setForm({ ...form, address })} />
        <TextInput label="备注" value={form.note} onChange={(note) => setForm({ ...form, note })} />
        {form.type === "customer" && <Check label="会员客户" checked={form.isMember === true} onChange={(isMember) => setForm({ ...form, isMember })} />}
        {form.id && <Check label="启用" checked={form.isActive !== false} onChange={(isActive) => setForm({ ...form, isActive })} />}
        <SubmitButton label={form.id ? "保存" : "新增"} />
      </form>
      <section className="panel">
        <h3>客户与供应商</h3>
        <SimpleTable
          headers={["类型", "名称", "联系人", "电话", "会员", "优惠商品", "状态", "操作"]}
          rows={partners.map((partner) => [
            partner.type === "supplier" ? "供应商" : "客户",
            partner.name,
            partner.contact || "-",
            partner.phone || "-",
            partner.isMember ? "是" : "-",
            partner.isMember ? formatMemberDiscounts(partner.memberDiscounts) : "-",
            partner.isActive ? "启用" : "停用",
            <div className="actions-inline">
              <button className="text-button" onClick={() => setForm(partner)}>
                编辑
              </button>
              <button className="text-button danger" onClick={() => deletePartner(partner.id)}>
                删除
              </button>
            </div>
          ])}
          empty="还没有客户或供应商"
        />
      </section>
    </section>
  );
}

function MemberCustomersView({
  customers,
  refreshAll,
  run
}: {
  customers: Partner[];
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const blankForm: Partial<Partner> = {
    type: "customer",
    name: "",
    contact: "",
    phone: "",
    address: "",
    note: "",
    isMember: true,
    memberDiscounts: [],
    isActive: true
  };
  const [form, setForm] = useState<Partial<Partner>>(blankForm);
  const [discountForm, setDiscountForm] = useState({ productName: "", discountAmount: 0 });
  const members = customers.filter((customer) => customer.isMember);

  async function save(event: FormEvent) {
    event.preventDefault();
    const payload = { ...form, type: "customer" as const, isMember: true };
    await run(() => (payload.id ? window.inventoryAPI.updatePartner(payload.id, payload) : window.inventoryAPI.createPartner(payload)), "会员客户已保存");
    setForm(blankForm);
    await refreshAll();
  }

  function addDiscount() {
    const productName = discountForm.productName.trim();
    const discountAmount = Number(discountForm.discountAmount ?? 0);
    if (!productName || !Number.isFinite(discountAmount) || discountAmount < 0) return;
    const nextDiscounts = [...(form.memberDiscounts ?? []).filter((item) => item.productName.trim() !== productName), { productName, discountAmount }];
    setForm({ ...form, memberDiscounts: nextDiscounts });
    setDiscountForm({ productName: "", discountAmount: 0 });
  }

  function removeDiscount(productName: string) {
    setForm({ ...form, memberDiscounts: (form.memberDiscounts ?? []).filter((item) => item.productName !== productName) });
  }

  return (
    <section className="stack">
      <form className="panel member-form" onSubmit={save}>
        <TextInput label="会员姓名" value={form.name} onChange={(name) => setForm({ ...form, name })} required />
        <TextInput label="电话" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
        <TextInput label="联系人" value={form.contact} onChange={(contact) => setForm({ ...form, contact })} />
        <TextInput label="备注" value={form.note} onChange={(note) => setForm({ ...form, note })} />
        {form.id && <Check label="启用" checked={form.isActive !== false} onChange={(isActive) => setForm({ ...form, isActive })} />}
        <div className="member-discount-editor">
          <TextInput label="优惠商品名称" value={discountForm.productName} onChange={(productName) => setDiscountForm({ ...discountForm, productName })} />
          <NumberInput label="单件优惠" value={discountForm.discountAmount} onChange={(discountAmount) => setDiscountForm({ ...discountForm, discountAmount })} />
          <button type="button" className="secondary" onClick={addDiscount}>
            添加优惠
          </button>
        </div>
        <div className="member-discount-list">
          {(form.memberDiscounts ?? []).length ? (
            (form.memberDiscounts ?? []).map((discount) => (
              <span key={discount.productName} className="discount-chip">
                {discount.productName} - {money(discount.discountAmount)}/件
                <button type="button" className="text-button" onClick={() => removeDiscount(discount.productName)}>
                  删除
                </button>
              </span>
            ))
          ) : (
            <span className="muted">未设置商品单件优惠</span>
          )}
        </div>
        <button type="submit">
          <UserPlus size={17} />
          {form.id ? "保存会员" : "新增会员"}
        </button>
      </form>
      <section className="panel">
        <h3>会员列表</h3>
        <SimpleTable
          headers={["姓名", "电话", "联系人", "优惠商品", "状态", "操作"]}
          rows={members.map((member) => [
            member.name,
            member.phone || "-",
            member.contact || "-",
            formatMemberDiscounts(member.memberDiscounts),
            member.isActive ? "启用" : "停用",
            <button className="text-button" onClick={() => setForm(member)}>
              编辑
            </button>
          ])}
          empty="还没有会员客户"
        />
      </section>
    </section>
  );
}

function InboundView({
  catalog,
  orders,
  refreshAll,
  run
}: {
  catalog: CatalogPayload;
  orders: OrderListItem[];
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [form, setForm] = useState<InboundOrderInput>({ supplierId: catalog.suppliers[0]?.id, orderDate: today(), note: "", lines: [] });
  const [line, setLine] = useState<OrderLineInput>({ skuId: catalog.skus[0]?.id ?? 0, quantity: 1, unitCost: catalog.skus[0]?.defaultCost ?? 0 });
  const [selectedSkuIds, setSelectedSkuIds] = useState<number[]>(catalog.skus[0]?.id ? [catalog.skus[0].id] : []);

  useEffect(() => {
    if (!line.skuId && catalog.skus[0]) setLine((current) => ({ ...current, skuId: catalog.skus[0].id, unitCost: catalog.skus[0].defaultCost }));
    if (!selectedSkuIds.length && catalog.skus[0]) setSelectedSkuIds([catalog.skus[0].id]);
  }, [catalog.skus, line.skuId, selectedSkuIds.length]);

  function updateSelectedSkus(skuIds: number[]) {
    setSelectedSkuIds(skuIds);
    const firstSku = catalog.skus.find((sku) => sku.id === skuIds[0]);
    if (firstSku) setLine((current) => ({ ...current, skuId: firstSku.id, unitCost: firstSku.defaultCost }));
  }

  function addLine() {
    if (!selectedSkuIds.length || !line.quantity || !line.unitCost) return;
    const newLines = selectedSkuIds.map((skuId) => ({ skuId, quantity: Number(line.quantity), unitCost: Number(line.unitCost) }));
    setForm({ ...form, lines: [...form.lines, ...newLines] });
    setSelectedSkuIds(catalog.skus[0]?.id ? [catalog.skus[0].id] : []);
    setLine({ skuId: catalog.skus[0]?.id ?? 0, quantity: 1, unitCost: catalog.skus[0]?.defaultCost ?? 0 });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await run(() => window.inventoryAPI.createInboundOrder(form), "入库单草稿已创建");
    setForm({ supplierId: catalog.suppliers[0]?.id, orderDate: today(), note: "", lines: [] });
    await refreshAll();
  }

  return (
    <OrderPage
      title="新增入库单"
      partnerLabel="供应商"
      partners={catalog.suppliers}
      form={form}
      setForm={setForm}
      line={line}
      setLine={setLine}
      multiSkuIds={selectedSkuIds}
      onMultiSkuIdsChange={updateSelectedSkus}
      skus={catalog.skus}
      priceLabel="采购单价"
      priceKey="unitCost"
      onAddLine={addLine}
      onSave={save}
      orders={orders}
      onApprove={(id) => run(async () => window.inventoryAPI.approveInboundOrder(id), "入库单已审核").then(refreshAll)}
      onVoid={(id) => run(async () => window.inventoryAPI.voidInboundOrder(id), "入库单已作废").then(refreshAll)}
    />
  );
}

function OutboundView({
  catalog,
  orders,
  refreshAll,
  run
}: {
  catalog: CatalogPayload;
  orders: OrderListItem[];
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [form, setForm] = useState<OutboundOrderInput>({ customerId: catalog.customers[0]?.id, orderDate: today(), note: "", lines: [] });
  const [line, setLine] = useState<OrderLineInput>({ skuId: catalog.skus[0]?.id ?? 0, quantity: 1, unitPrice: catalog.skus[0]?.defaultPrice ?? 0 });
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printerName, setPrinterName] = useState(window.localStorage.getItem("kucun.printerName") ?? "");
  const [silentPrint, setSilentPrint] = useState(window.localStorage.getItem("kucun.silentPrint") === "true");
  const [hideCostPrint, setHideCostPrint] = useState(window.localStorage.getItem("kucun.hideCostPrint") !== "false");

  function priceFor(skuId: number, customerId?: number | null) {
    const sku = catalog.skus.find((item) => item.id === skuId);
    const customer = catalog.customers.find((item) => item.id === customerId);
    return memberPrice(sku, customer);
  }

  useEffect(() => {
    if (!line.skuId && catalog.skus[0]) {
      setLine((current) => ({ ...current, skuId: catalog.skus[0].id, unitPrice: priceFor(catalog.skus[0].id, form.customerId) }));
    }
  }, [catalog.skus, line.skuId]);

  useEffect(() => {
    if (line.skuId) setLine((current) => ({ ...current, unitPrice: priceFor(current.skuId, form.customerId) }));
  }, [form.customerId, catalog.customers]);

  useEffect(() => {
    void run(async () => {
      const printerList = await window.inventoryAPI.listPrinters();
      setPrinters(printerList);
      const defaultPrinter = printerList.find((printer) => printer.isDefault);
      if (!printerName && defaultPrinter) setPrinterName(defaultPrinter.name);
    });
  }, []);

  function savePrinterName(name: string) {
    setPrinterName(name);
    window.localStorage.setItem("kucun.printerName", name);
  }

  function saveSilentPrint(checked: boolean) {
    setSilentPrint(checked);
    window.localStorage.setItem("kucun.silentPrint", String(checked));
  }

  function saveHideCostPrint(checked: boolean) {
    setHideCostPrint(checked);
    window.localStorage.setItem("kucun.hideCostPrint", String(checked));
  }

  function updateSku(skuId: number) {
    setLine({ ...line, skuId, unitPrice: priceFor(skuId, form.customerId) });
  }

  function addLine() {
    if (!line.skuId || !line.quantity || line.unitPrice === undefined) return;
    setForm({ ...form, lines: [...form.lines, { skuId: line.skuId, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) }] });
    setLine({ skuId: catalog.skus[0]?.id ?? 0, quantity: 1, unitPrice: priceFor(catalog.skus[0]?.id ?? 0, form.customerId) });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await run(() => window.inventoryAPI.createOutboundOrder(form), "出库单草稿已创建");
    setForm({ customerId: catalog.customers[0]?.id, orderDate: today(), note: "", lines: [] });
    setLine({ skuId: catalog.skus[0]?.id ?? 0, quantity: 1, unitPrice: priceFor(catalog.skus[0]?.id ?? 0, catalog.customers[0]?.id) });
    await refreshAll();
  }

  const printOptions = {
    printerName: printerName || null,
    silent: silentPrint,
    hideCost: hideCostPrint
  };

  return (
    <OrderPage
      title="新增出库单"
      partnerLabel="客户"
      partners={catalog.customers}
      form={form}
      setForm={setForm}
      onPartnerChange={(value) => {
        const customerId = Number(value) || null;
        setForm({ ...form, customerId });
        if (line.skuId) setLine({ ...line, unitPrice: priceFor(line.skuId, customerId) });
      }}
      line={line}
      setLine={setLine}
      onSkuChange={updateSku}
      skus={catalog.skus}
      priceLabel="销售单价"
      priceKey="unitPrice"
      onAddLine={addLine}
      onSave={save}
      orders={orders}
      approveLabel="打印并出库"
      onApprove={(id) =>
        run(async () => window.inventoryAPI.printOutboundReceipt(id, { ...printOptions, approveAfterPrint: true }), "小票已打印，出库已完成").then(refreshAll)
      }
      onReprint={(id) => run(async () => window.inventoryAPI.printOutboundReceipt(id, { ...printOptions, approveAfterPrint: false }), "小票已补打").then(refreshAll)}
      onVoid={(id) => run(async () => window.inventoryAPI.voidOutboundOrder(id), "出库单已作废").then(refreshAll)}
      tools={
        <div className="print-tools">
          <Select label="小票打印机" value={printerName} onChange={savePrinterName}>
            <option value="">系统默认打印机</option>
            {printers.map((printer) => (
              <option key={printer.name} value={printer.name}>
                {printer.displayName}
                {printer.isDefault ? "（默认）" : ""}
              </option>
            ))}
          </Select>
          <Check label="静默打印" checked={silentPrint} onChange={saveSilentPrint} />
          <Check label="不打印成本" checked={hideCostPrint} onChange={saveHideCostPrint} />
        </div>
      }
    />
  );
}

function OrderPage({
  title,
  partnerLabel,
  partners,
  form,
  setForm,
  onPartnerChange,
  line,
  setLine,
  onSkuChange,
  multiSkuIds,
  onMultiSkuIdsChange,
  skus,
  priceLabel,
  priceKey,
  onAddLine,
  onSave,
  orders,
  onApprove,
  onVoid,
  onReprint,
  approveLabel = "审核",
  tools
}: {
  title: string;
  partnerLabel: string;
  partners: Partner[];
  form: InboundOrderInput | OutboundOrderInput;
  setForm: (form: any) => void;
  onPartnerChange?: (value: string) => void;
  line: OrderLineInput;
  setLine: (line: OrderLineInput) => void;
  onSkuChange?: (skuId: number) => void;
  multiSkuIds?: number[];
  onMultiSkuIdsChange?: (skuIds: number[]) => void;
  skus: Sku[];
  priceLabel: string;
  priceKey: "unitCost" | "unitPrice";
  onAddLine: () => void;
  onSave: (event: FormEvent) => void;
  orders: OrderListItem[];
  onApprove: (id: number) => void;
  onVoid: (id: number) => void;
  onReprint?: (id: number) => void;
  approveLabel?: string;
  tools?: React.ReactNode;
}) {
  const selectedLines = form.lines.map((item) => {
    const sku = skus.find((candidate) => candidate.id === item.skuId);
    const price = priceKey === "unitCost" ? item.unitCost ?? 0 : item.unitPrice ?? 0;
    return [sku ? `${sku.productName} / ${sku.name}` : item.skuId, qty(item.quantity), money(price), money(Number(item.quantity) * Number(price))];
  });

  return (
    <section className="stack">
      <form className="panel" onSubmit={onSave}>
        <h3>{title}</h3>
        <div className="form-row">
          <Select
            label={partnerLabel}
            value={"supplierId" in form ? form.supplierId ?? "" : form.customerId ?? ""}
            onChange={(value) =>
              onPartnerChange
                ? onPartnerChange(value)
                : setForm("supplierId" in form ? { ...form, supplierId: Number(value) || null } : { ...form, customerId: Number(value) || null })
            }
          >
            <option value="">未选择</option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.isMember ? `${partner.name}（单件优惠）` : partner.name}
              </option>
            ))}
          </Select>
          <TextInput label="单据日期" type="date" value={form.orderDate} onChange={(orderDate) => setForm({ ...form, orderDate })} required />
          <TextInput label="备注" value={form.note} onChange={(note) => setForm({ ...form, note })} />
        </div>
        <div className={`line-editor ${multiSkuIds ? "multi-sku-line" : ""}`}>
          {multiSkuIds && onMultiSkuIdsChange ? (
            <MultiSkuPicker skus={skus} selectedIds={multiSkuIds} onChange={onMultiSkuIdsChange} />
          ) : (
            <Select
              label="SKU"
              value={line.skuId || ""}
              onChange={(value) => {
                const skuId = Number(value);
                onSkuChange ? onSkuChange(skuId) : setLine({ ...line, skuId });
              }}
            >
              {skus.map((sku) => (
                <option key={sku.id} value={sku.id}>
                  {sku.productName} / {sku.name}
                </option>
              ))}
            </Select>
          )}
          <NumberInput label="数量" value={line.quantity} onChange={(quantity) => setLine({ ...line, quantity })} />
          <NumberInput label={priceLabel} value={line[priceKey]} onChange={(value) => setLine({ ...line, [priceKey]: value })} />
          <button type="button" className="secondary" onClick={onAddLine}>
            加入明细
          </button>
        </div>
        <SimpleTable headers={["SKU", "数量", priceLabel, "金额"]} rows={selectedLines} empty="请添加单据明细" />
        <div className="actions">
          <SubmitButton label="保存草稿" />
        </div>
      </form>
      <section className="panel">
        <div className="panel-title">
          <h3>单据列表</h3>
          {tools}
        </div>
        <table>
          <thead>
            <tr>
              <th>单号</th>
              <th>状态</th>
              <th>{partnerLabel}</th>
              <th>日期</th>
              <th>金额</th>
              <th>成本</th>
              <th>利润</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{order.orderNo}</td>
                <td>
                  <StatusBadge status={order.status} />
                </td>
                <td>{order.partnerName || "-"}</td>
                <td>{order.orderDate}</td>
                <td>{money(order.totalAmount)}</td>
                <td>{order.totalCost ? money(order.totalCost) : "-"}</td>
                <td>{order.totalProfit ? money(order.totalProfit) : "-"}</td>
                <td className="right actions-inline">
                  {order.status === "draft" && (
                    <button className="text-button" onClick={() => onApprove(order.id)}>
                      {approveLabel}
                    </button>
                  )}
                  {order.status === "approved" && onReprint && (
                    <button className="text-button" onClick={() => onReprint(order.id)}>
                      <Printer size={14} />
                      补打
                    </button>
                  )}
                  {order.status !== "voided" && (
                    <button className="text-button danger" onClick={() => onVoid(order.id)}>
                      作废
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

function MultiSkuPicker({ skus, selectedIds, onChange }: { skus: Sku[]; selectedIds: number[]; onChange: (skuIds: number[]) => void }) {
  function toggleSku(skuId: number, checked: boolean) {
    if (checked) {
      onChange(Array.from(new Set([...selectedIds, skuId])));
      return;
    }
    onChange(selectedIds.filter((id) => id !== skuId));
  }

  return (
    <div className="multi-sku-picker">
      <div className="multi-sku-title">
        <span>SKU（可多选）</span>
        <div>
          <button type="button" className="text-button" onClick={() => onChange(skus.map((sku) => sku.id))}>
            全选
          </button>
          <button type="button" className="text-button" onClick={() => onChange([])}>
            清空
          </button>
        </div>
      </div>
      <div className="sku-check-list">
        {skus.map((sku) => (
          <label key={sku.id} className="sku-check-option">
            <input type="checkbox" checked={selectedIds.includes(sku.id)} onChange={(event) => toggleSku(sku.id, event.target.checked)} />
            <span>
              {sku.productName} / {sku.name}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function InventoryView({ rows, title = "仓库库存" }: { rows: InventoryRow[]; title?: string }) {
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<{ key: InventorySortKey; direction: SortDirection }>({ key: "productName", direction: "asc" });
  const filtered = rows.filter((row) => `${row.productName}${row.skuName}${row.skuCode ?? ""}`.includes(keyword));
  const sorted = [...filtered].sort((left, right) => compareInventoryRows(left, right, sort.key, sort.direction));

  function updateSort(key: InventorySortKey) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h3>{title}</h3>
        <label className="search">
          <Search size={16} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索商品、SKU、编码" />
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th>
              <SortHeader label="商品" active={sort.key === "productName"} direction={sort.direction} onClick={() => updateSort("productName")} />
            </th>
            <th>
              <SortHeader label="SKU" active={sort.key === "skuName"} direction={sort.direction} onClick={() => updateSort("skuName")} />
            </th>
            <th>
              <SortHeader label="编码" active={sort.key === "skuCode"} direction={sort.direction} onClick={() => updateSort("skuCode")} />
            </th>
            <th>
              <SortHeader label="仓库库存" active={sort.key === "warehouseStock"} direction={sort.direction} onClick={() => updateSort("warehouseStock")} />
            </th>
            <th>
              <SortHeader label="门市库存" active={sort.key === "storefrontStock"} direction={sort.direction} onClick={() => updateSort("storefrontStock")} />
            </th>
            <th>
              <SortHeader label="总库存" active={sort.key === "currentStock"} direction={sort.direction} onClick={() => updateSort("currentStock")} />
            </th>
            <th>
              <SortHeader label="库存成本" active={sort.key === "stockValue"} direction={sort.direction} onClick={() => updateSort("stockValue")} />
            </th>
            <th>
              <SortHeader label="售价" active={sort.key === "defaultPrice"} direction={sort.direction} onClick={() => updateSort("defaultPrice")} />
            </th>
            <th>
              <SortHeader label="低库存" active={sort.key === "isLowStock"} direction={sort.direction} onClick={() => updateSort("isLowStock")} />
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.skuId} className={row.isLowStock ? "warn-row" : ""}>
              <td>{row.productName}</td>
              <td>{row.skuName}</td>
              <td>{row.skuCode || "-"}</td>
              <td>
                {qty(row.warehouseStock)} {row.unit}
              </td>
              <td>
                {qty(row.storefrontStock)} {row.unit}
              </td>
              <td>
                {qty(row.currentStock)} {row.unit}
              </td>
              <td>{money(row.stockValue)}</td>
              <td>{money(row.defaultPrice)}</td>
              <td>{row.isLowStock ? "是" : "否"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!sorted.length && <div className="empty">暂无匹配库存</div>}
    </section>
  );
}

function compareInventoryRows(left: InventoryRow, right: InventoryRow, key: InventorySortKey, direction: SortDirection) {
  const factor = direction === "asc" ? 1 : -1;
  if (key === "warehouseStock" || key === "storefrontStock" || key === "currentStock" || key === "stockValue" || key === "defaultPrice") {
    return (Number(left[key]) - Number(right[key])) * factor;
  }
  if (key === "isLowStock") {
    return (Number(left.isLowStock) - Number(right.isLowStock)) * factor;
  }
  return String(left[key] ?? "").localeCompare(String(right[key] ?? ""), "zh-CN", { numeric: true }) * factor;
}

function TransferToStorefrontView({
  catalog,
  inventory,
  refreshAll,
  run
}: {
  catalog: CatalogPayload;
  inventory: InventoryRow[];
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [skuId, setSkuId] = useState(catalog.skus[0]?.id ?? 0);
  const [quantity, setQuantity] = useState(1);
  const selectedInventory = inventory.find((row) => row.skuId === skuId);

  useEffect(() => {
    if (!skuId && catalog.skus[0]) setSkuId(catalog.skus[0].id);
  }, [catalog.skus, skuId]);

  async function transfer(event: FormEvent) {
    event.preventDefault();
    await run(() => window.inventoryAPI.transferToStorefront({ skuId, quantity }), "已调拨到门市");
    setQuantity(1);
    await refreshAll();
  }

  return (
    <form className="panel transfer-panel" onSubmit={transfer}>
      <Select label="SKU" value={skuId || ""} onChange={(value) => setSkuId(Number(value))}>
        {catalog.skus.map((sku) => (
          <option key={sku.id} value={sku.id}>
            {sku.productName} / {sku.name}
          </option>
        ))}
      </Select>
      <NumberInput label="调拨数量" value={quantity} onChange={setQuantity} />
      <div className="transfer-stock">
        仓库可调：{qty(selectedInventory?.warehouseStock)} {selectedInventory?.unit ?? ""}
      </div>
      <button type="submit">
        <Truck size={17} />
        调拨到门市
      </button>
    </form>
  );
}

function NetworkSettingsView({
  status,
  refreshAll,
  run
}: {
  status: NetworkStatus | null;
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [form, setForm] = useState<NetworkConfig>(status?.config ?? { mode: "local", hostPort: 8787, serverUrl: "" });

  useEffect(() => {
    if (status?.config) setForm(status.config);
  }, [status?.config]);

  async function save(event: FormEvent) {
    event.preventDefault();
    await run(() => window.inventoryAPI.setNetworkConfig(form), "联机设置已保存");
    await refreshAll();
  }

  async function testConnection() {
    const ok = await run(() => window.inventoryAPI.testServerConnection(form.serverUrl));
    if (ok) {
      await run(async () => true, "主机连接正常");
    }
  }

  return (
    <section className="panel network-panel">
      <form className="network-form" onSubmit={save}>
        <Select label="运行模式" value={form.mode} onChange={(mode) => setForm({ ...form, mode: mode as NetworkConfig["mode"] })}>
          <option value="local">单机模式</option>
          <option value="host">主机模式（仓库电脑）</option>
          <option value="client">客户端模式（门市/仓库电脑）</option>
        </Select>
        <NumberInput label="主机端口" value={form.hostPort} onChange={(hostPort) => setForm({ ...form, hostPort })} />
        <TextInput label="主机地址" value={form.serverUrl} onChange={(serverUrl) => setForm({ ...form, serverUrl })} />
        <button type="submit">
          <Save size={17} />
          保存联机设置
        </button>
        <button type="button" className="secondary" onClick={testConnection}>
          测试连接
        </button>
      </form>
      <div className="network-status">
        <div>
          <strong>当前状态</strong>
          <span>
            {status?.config.mode === "host"
              ? status.serverRunning
                ? "主机服务运行中"
                : "主机服务未启动"
              : status?.config.mode === "client"
                ? "客户端连接主机"
                : "单机本地使用"}
          </span>
        </div>
        {status?.config.mode === "host" && (
          <div>
            <strong>门市/仓库客户端填写</strong>
            <span>{status.lanUrls.length ? status.lanUrls.join(" 或 ") : `http://主机IP:${status.config.hostPort}`}</span>
          </div>
        )}
        {status?.config.mode === "client" && (
          <div>
            <strong>正在连接</strong>
            <span>{status.config.serverUrl || "未填写主机地址"}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function StorefrontStockIncreaseView({
  catalog,
  inventory,
  refreshAll,
  run
}: {
  catalog: CatalogPayload;
  inventory: InventoryRow[];
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const [skuId, setSkuId] = useState(catalog.skus[0]?.id ?? 0);
  const [quantity, setQuantity] = useState(1);
  const [unitCost, setUnitCost] = useState(catalog.skus[0]?.defaultCost ?? 0);
  const selectedInventory = inventory.find((row) => row.skuId === skuId);

  useEffect(() => {
    if (!skuId && catalog.skus[0]) {
      setSkuId(catalog.skus[0].id);
      setUnitCost(catalog.skus[0].defaultCost);
    }
  }, [catalog.skus, skuId]);

  function selectSku(value: string) {
    const nextSkuId = Number(value);
    setSkuId(nextSkuId);
    const sku = catalog.skus.find((item) => item.id === nextSkuId);
    if (sku) setUnitCost(sku.defaultCost);
  }

  async function addStock(event: FormEvent) {
    event.preventDefault();
    await run(() => window.inventoryAPI.addStorefrontStock({ skuId, quantity, unitCost }), "门市库存已增加");
    setQuantity(1);
    await refreshAll();
  }

  return (
    <form className="panel transfer-panel storefront-increase-panel" onSubmit={addStock}>
      <Select label="SKU" value={skuId || ""} onChange={selectSku}>
        {catalog.skus.map((sku) => (
          <option key={sku.id} value={sku.id}>
            {sku.productName} / {sku.name}
          </option>
        ))}
      </Select>
      <NumberInput label="增加数量" value={quantity} onChange={setQuantity} />
      <NumberInput label="成本价" value={unitCost} onChange={setUnitCost} />
      <div className="transfer-stock">
        门市现有：{qty(selectedInventory?.storefrontStock)} {selectedInventory?.unit ?? ""}
      </div>
      <button type="submit">
        <PackagePlus size={17} />
        增加门市库存
      </button>
    </form>
  );
}

function StoreInventoryView({ rows }: { rows: InventoryRow[] }) {
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<{ key: StoreInventorySortKey; direction: SortDirection }>({ key: "productName", direction: "asc" });
  const filtered = rows.filter((row) => `${row.productName}${row.skuName}${row.skuCode ?? ""}`.includes(keyword));
  const sorted = [...filtered].sort((left, right) => compareStoreInventoryRows(left, right, sort.key, sort.direction));

  function updateSort(key: StoreInventorySortKey) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h3>门市库存</h3>
        <label className="search">
          <Search size={16} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索商品、SKU、编码" />
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th>
              <SortHeader label="商品" active={sort.key === "productName"} direction={sort.direction} onClick={() => updateSort("productName")} />
            </th>
            <th>
              <SortHeader label="SKU" active={sort.key === "skuName"} direction={sort.direction} onClick={() => updateSort("skuName")} />
            </th>
            <th>
              <SortHeader label="编码" active={sort.key === "skuCode"} direction={sort.direction} onClick={() => updateSort("skuCode")} />
            </th>
            <th>
              <SortHeader label="可售数量" active={sort.key === "storefrontStock"} direction={sort.direction} onClick={() => updateSort("storefrontStock")} />
            </th>
            <th>
              <SortHeader label="售价" active={sort.key === "defaultPrice"} direction={sort.direction} onClick={() => updateSort("defaultPrice")} />
            </th>
            <th>
              <SortHeader label="低库存" active={sort.key === "isLowStock"} direction={sort.direction} onClick={() => updateSort("isLowStock")} />
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.skuId} className={row.isLowStock ? "warn-row" : ""}>
              <td>{row.productName}</td>
              <td>{row.skuName}</td>
              <td>{row.skuCode || "-"}</td>
              <td>
                {qty(row.storefrontStock)} {row.unit}
              </td>
              <td>{money(row.defaultPrice)}</td>
              <td>{row.isLowStock ? "是" : "否"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!sorted.length && <div className="empty">暂无门市库存</div>}
    </section>
  );
}

function compareStoreInventoryRows(left: InventoryRow, right: InventoryRow, key: StoreInventorySortKey, direction: SortDirection) {
  const factor = direction === "asc" ? 1 : -1;
  if (key === "storefrontStock" || key === "defaultPrice") {
    return (Number(left[key]) - Number(right[key])) * factor;
  }
  if (key === "isLowStock") {
    return (Number(left.isLowStock) - Number(right.isLowStock)) * factor;
  }
  return String(left[key] ?? "").localeCompare(String(right[key] ?? ""), "zh-CN", { numeric: true }) * factor;
}

function SortHeader({ label, active, direction, onClick }: { label: string; active: boolean; direction: SortDirection; onClick: () => void }) {
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button type="button" className={`sort-header ${active ? "active" : ""}`} onClick={onClick}>
      <span>{label}</span>
      <Icon size={13} />
    </button>
  );
}

function MovementsView({ rows }: { rows: MovementRow[] }) {
  const [keyword, setKeyword] = useState("");
  const filtered = rows.filter((row) => `${row.productName}${row.skuName}${row.orderNo ?? ""}`.includes(keyword));
  return (
    <section className="panel">
      <div className="panel-title">
        <h3>出入库明细</h3>
        <label className="search">
          <Search size={16} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索商品、SKU、单号" />
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>商品</th>
            <th>SKU</th>
            <th>数量</th>
            <th>成本</th>
            <th>销售</th>
            <th>利润</th>
            <th>单号</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((row) => (
            <tr key={row.id}>
              <td>{row.occurredAt.slice(0, 10)}</td>
              <td>{row.type === "in" ? "入库" : "出库"}</td>
              <td>{row.productName}</td>
              <td>{row.skuName}</td>
              <td>{qty(row.quantity)}</td>
              <td>{money(row.costAmount)}</td>
              <td>{money(row.salesAmount)}</td>
              <td>{money(row.profitAmount)}</td>
              <td>{row.orderNo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ProfitView({ rows }: { rows: ProfitRow[] }) {
  const total = rows.reduce(
    (sum, row) => ({
      quantity: sum.quantity + row.quantity,
      salesAmount: sum.salesAmount + row.salesAmount,
      costAmount: sum.costAmount + row.costAmount,
      profitAmount: sum.profitAmount + row.profitAmount
    }),
    { quantity: 0, salesAmount: 0, costAmount: 0, profitAmount: 0 }
  );
  return (
    <section className="stack">
      <div className="metrics">
        <Metric label="销售数量" value={qty(total.quantity)} />
        <Metric label="销售额" value={money(total.salesAmount)} />
        <Metric label="成本" value={money(total.costAmount)} />
        <Metric label="利润" value={money(total.profitAmount)} />
      </div>
      <section className="panel">
        <h3>按SKU统计</h3>
        <SimpleTable
          headers={["商品", "SKU", "数量", "销售额", "成本", "利润"]}
          rows={rows.map((row) => [row.productName, row.skuName, qty(row.quantity), money(row.salesAmount), money(row.costAmount), money(row.profitAmount)])}
          empty="暂无利润数据"
        />
      </section>
    </section>
  );
}

function BackupView({
  backups,
  refreshAll,
  run
}: {
  backups: BackupInfo[];
  refreshAll: () => Promise<void>;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  async function backup() {
    const file = await run(() => window.inventoryAPI.createBackup(), "备份已生成");
    if (file) await refreshAll();
  }

  async function exportExcel() {
    const file = await run(() => window.inventoryAPI.exportExcel(), "Excel已导出");
    if (file) await window.inventoryAPI.revealPath(file);
  }

  return (
    <section className="stack">
      <div className="toolbar">
        <button onClick={exportExcel}>
          <FileDown size={17} />
          导出Excel
        </button>
        <button className="secondary" onClick={backup}>
          <Archive size={17} />
          立即备份
        </button>
      </div>
      <section className="panel">
        <h3>备份文件</h3>
        <SimpleTable
          headers={["文件名", "大小", "创建时间", "位置"]}
          rows={backups.map((backup) => [
            backup.fileName,
            `${Math.max(1, Math.round(backup.size / 1024))} KB`,
            backup.createdAt.slice(0, 19).replace("T", " "),
            <button className="text-button" onClick={() => window.inventoryAPI.revealPath(backup.fullPath)}>
              打开位置
            </button>
          ])}
          empty="暂无备份文件"
        />
      </section>
    </section>
  );
}

function StatusBadge({ status }: { status: OrderListItem["status"] }) {
  const text = status === "draft" ? "草稿" : status === "approved" ? "已审核" : "已作废";
  return <span className={`status ${status}`}>{text}</span>;
}

function SimpleTable({ headers, rows, empty }: { headers: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <table>
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header}>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TextInput({
  label,
  value,
  onChange,
  required,
  type = "text"
}: {
  label: string;
  value: unknown;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type={type} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} required={required} />
    </label>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: unknown; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <textarea value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: unknown; onChange: (value: number) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" min="0" step="0.01" value={Number(value ?? 0)} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string | number; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function SubmitButton({ label }: { label: string }) {
  return (
    <button type="submit">
      <Save size={17} />
      {label}
    </button>
  );
}

export default App;
