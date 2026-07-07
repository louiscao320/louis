import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import type {
  BackupInfo,
  CatalogPayload,
  Dashboard,
  InboundOrderInput,
  InventoryRow,
  MovementRow,
  OrderListItem,
  OutboundReceipt,
  OutboundOrderInput,
  Partner,
  Product,
  ProfitRow,
  Sku,
  StockIncreaseInput,
  StockTransferInput,
  AuthUser,
  LoginInput,
  UserInput,
  UserRole
} from "../shared/types.js";

type Db = Database.Database;

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const toBool = (value: unknown) => Boolean(Number(value));
const now = () => new Date().toISOString();
const passwordIterations = 120000;

function normalizeRole(value: unknown): UserRole {
  return value === "storefront" || value === "warehouse" ? value : "admin";
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, passwordIterations, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const hash = crypto.pbkdf2Sync(password, salt, passwordIterations, 32, "sha256").toString("hex");
  const hashBuffer = Buffer.from(hash, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (hashBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, expectedBuffer);
}

function mapProduct(row: any): Product {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    category: row.category,
    note: row.note,
    isActive: toBool(row.is_active),
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSku(row: any): Sku {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    name: row.name,
    skuCode: row.sku_code,
    barcode: row.barcode,
    unit: row.unit,
    defaultCost: Number(row.default_cost ?? 0),
    defaultPrice: Number(row.default_price ?? 0),
    lowStockThreshold: Number(row.low_stock_threshold ?? 0),
    currentStock: Number(row.current_stock ?? 0),
    isActive: toBool(row.is_active),
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPartner(row: any): Partner {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    contact: row.contact,
    phone: row.phone,
    address: row.address,
    note: row.note,
    isMember: toBool(row.is_member),
    memberDiscounts: parseMemberDiscounts(row.member_discounts),
    isActive: toBool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUser(row: any): AuthUser {
  return {
    id: row.id,
    username: row.username,
    role: normalizeRole(row.role),
    isActive: toBool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseMemberDiscounts(value: unknown) {
  if (!value) return [];
  try {
    const discounts = JSON.parse(String(value));
    if (!Array.isArray(discounts)) return [];
    return discounts
      .map((item) => ({
        productName: String(item.productName ?? "").trim(),
        discountAmount: Number(item.discountAmount ?? 0)
      }))
      .filter((item) => item.productName && Number.isFinite(item.discountAmount) && item.discountAmount >= 0);
  } catch {
    return [];
  }
}

function mapOrder(row: any): OrderListItem {
  return {
    id: row.id,
    orderNo: row.order_no,
    status: row.status,
    partnerName: row.partner_name,
    orderDate: row.order_date,
    totalAmount: Number(row.total_amount ?? 0),
    totalCost: Number(row.total_cost ?? 0),
    totalProfit: Number(row.total_profit ?? 0),
    note: row.note,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    voidedAt: row.voided_at
  };
}

function requireText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function requirePositive(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于0`);
  return number;
}

function makeOrderNo(prefix: "IN" | "OUT"): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}${stamp}${suffix}`;
}

export class InventoryStore {
  private db: Db;
  private dbPath: string;
  private backupDir: string;
  private exportDir: string;

  constructor(dbPath: string, dataDir: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = dbPath;
    this.backupDir = path.join(dataDir, "backups");
    this.exportDir = path.join(dataDir, "exports");
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.mkdirSync(this.exportDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT,
        category TEXT,
        note TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skus (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        name TEXT NOT NULL,
        sku_code TEXT,
        barcode TEXT,
        unit TEXT NOT NULL DEFAULT '件',
        default_cost REAL NOT NULL DEFAULT 0,
        default_price REAL NOT NULL DEFAULT 0,
        low_stock_threshold REAL NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS partners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('supplier','customer')),
        name TEXT NOT NULL,
        contact TEXT,
        phone TEXT,
        address TEXT,
        note TEXT,
        is_member INTEGER NOT NULL DEFAULT 0,
        discount_rate REAL NOT NULL DEFAULT 100,
        member_discounts TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','storefront','warehouse')) DEFAULT 'admin',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT NOT NULL UNIQUE,
        supplier_id INTEGER REFERENCES partners(id),
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','voided')),
        order_date TEXT NOT NULL,
        note TEXT,
        total_amount REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        voided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS inbound_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES inbound_orders(id) ON DELETE CASCADE,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        quantity REAL NOT NULL,
        unit_cost REAL NOT NULL,
        amount REAL NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS outbound_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT NOT NULL UNIQUE,
        customer_id INTEGER REFERENCES partners(id),
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','voided')),
        order_date TEXT NOT NULL,
        note TEXT,
        total_amount REAL NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        total_profit REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        voided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS outbound_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES outbound_orders(id) ON DELETE CASCADE,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        quantity REAL NOT NULL,
        unit_price REAL NOT NULL,
        amount REAL NOT NULL,
        cost_amount REAL NOT NULL DEFAULT 0,
        profit_amount REAL NOT NULL DEFAULT 0,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS stock_lots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        inbound_line_id INTEGER NOT NULL REFERENCES inbound_lines(id),
        inbound_order_id INTEGER NOT NULL REFERENCES inbound_orders(id),
        lot_no TEXT NOT NULL,
        stock_location TEXT NOT NULL DEFAULT 'warehouse' CHECK(stock_location IN ('warehouse','storefront')),
        received_quantity REAL NOT NULL,
        remaining_quantity REAL NOT NULL,
        unit_cost REAL NOT NULL,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        type TEXT NOT NULL CHECK(type IN ('in','out')),
        quantity REAL NOT NULL,
        unit_cost REAL,
        unit_price REAL,
        cost_amount REAL NOT NULL DEFAULT 0,
        sales_amount REAL NOT NULL DEFAULT 0,
        profit_amount REAL NOT NULL DEFAULT 0,
        lot_id INTEGER REFERENCES stock_lots(id),
        order_type TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        line_id INTEGER NOT NULL,
        note TEXT,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lot_consumptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        outbound_line_id INTEGER NOT NULL REFERENCES outbound_lines(id) ON DELETE CASCADE,
        lot_id INTEGER NOT NULL REFERENCES stock_lots(id),
        quantity REAL NOT NULL,
        unit_cost REAL NOT NULL,
        cost_amount REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skus_product ON skus(product_id);
      CREATE INDEX IF NOT EXISTS idx_lots_sku_remaining ON stock_lots(sku_id, stock_location, remaining_quantity);
      CREATE INDEX IF NOT EXISTS idx_movements_sku_time ON stock_movements(sku_id, occurred_at);
    `);
    const lotColumns = this.db.prepare("PRAGMA table_info(stock_lots)").all() as any[];
    if (!lotColumns.some((column) => column.name === "stock_location")) {
      this.db.exec("ALTER TABLE stock_lots ADD COLUMN stock_location TEXT NOT NULL DEFAULT 'warehouse'");
    }
    const productColumns = this.db.prepare("PRAGMA table_info(products)").all() as any[];
    if (!productColumns.some((column) => column.name === "deleted_at")) {
      this.db.exec("ALTER TABLE products ADD COLUMN deleted_at TEXT");
    }
    const skuColumns = this.db.prepare("PRAGMA table_info(skus)").all() as any[];
    if (!skuColumns.some((column) => column.name === "default_cost")) {
      this.db.exec("ALTER TABLE skus ADD COLUMN default_cost REAL NOT NULL DEFAULT 0");
    }
    if (!skuColumns.some((column) => column.name === "deleted_at")) {
      this.db.exec("ALTER TABLE skus ADD COLUMN deleted_at TEXT");
    }
    const partnerColumns = this.db.prepare("PRAGMA table_info(partners)").all() as any[];
    if (!partnerColumns.some((column) => column.name === "is_member")) {
      this.db.exec("ALTER TABLE partners ADD COLUMN is_member INTEGER NOT NULL DEFAULT 0");
    }
    if (!partnerColumns.some((column) => column.name === "discount_rate")) {
      this.db.exec("ALTER TABLE partners ADD COLUMN discount_rate REAL NOT NULL DEFAULT 100");
    }
    if (!partnerColumns.some((column) => column.name === "member_discounts")) {
      this.db.exec("ALTER TABLE partners ADD COLUMN member_discounts TEXT NOT NULL DEFAULT '[]'");
    }
    const userCount = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    if (!Number(userCount.count)) {
      const date = now();
      this.db
        .prepare("INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, 'admin', 1, ?, ?)")
        .run("admin", hashPassword("admin123"), date, date);
    }
  }

  login(input: LoginInput): AuthUser {
    const username = requireText(input.username, "用户名");
    const password = String(input.password ?? "");
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
    if (!row || !toBool(row.is_active) || !verifyPassword(password, row.password_hash)) {
      throw new Error("用户名或密码不正确");
    }
    return mapUser(row);
  }

  listUsers(): AuthUser[] {
    return this.db.prepare("SELECT * FROM users ORDER BY is_active DESC, role, username").all().map(mapUser);
  }

  createUser(input: UserInput): AuthUser {
    const date = now();
    const username = requireText(input.username, "用户名");
    const password = requireText(input.password, "密码");
    const role = normalizeRole(input.role);
    const info = this.db
      .prepare("INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
      .run(username, hashPassword(password), role, date, date);
    return mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid));
  }

  updateUser(id: number, input: UserInput): AuthUser {
    const existing = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    if (!existing) throw new Error("账号不存在");
    const username = requireText(input.username, "用户名");
    const role = normalizeRole(input.role);
    const isActive = input.isActive === false ? 0 : 1;
    const password = String(input.password ?? "").trim();
    if (!isActive && existing.role === "admin") {
      const activeAdmins = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?").get(id) as { count: number };
      if (!Number(activeAdmins.count)) throw new Error("至少保留一个启用的管理员账号");
    }
    if (password) {
      this.db
        .prepare("UPDATE users SET username = ?, password_hash = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?")
        .run(username, hashPassword(password), role, isActive, now(), id);
    } else {
      this.db.prepare("UPDATE users SET username = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?").run(username, role, isActive, now(), id);
    }
    return mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  deleteUser(id: number): void {
    const existing = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    if (!existing) throw new Error("账号不存在");
    if (existing.role === "admin") {
      const activeAdmins = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?").get(id) as { count: number };
      if (!Number(activeAdmins.count)) throw new Error("至少保留一个启用的管理员账号");
    }
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  createDailyBackupIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `auto-${today}.sqlite`);
    if (!fs.existsSync(target) && fs.existsSync(this.dbPath)) {
      this.createBackup(target);
    }
  }

  createBackup(targetPath?: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = targetPath ?? path.join(this.backupDir, `manual-${stamp}.sqlite`);
    this.db.pragma("wal_checkpoint(FULL)");
    fs.copyFileSync(this.dbPath, target);
    return target;
  }

  listBackups(): BackupInfo[] {
    return fs
      .readdirSync(this.backupDir)
      .filter((fileName) => fileName.endsWith(".sqlite"))
      .map((fileName) => {
        const fullPath = path.join(this.backupDir, fileName);
        const stat = fs.statSync(fullPath);
        return { fileName, fullPath, size: stat.size, createdAt: stat.birthtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getCatalog(): CatalogPayload {
    const products = this.db.prepare("SELECT * FROM products WHERE deleted_at IS NULL ORDER BY is_active DESC, name").all().map(mapProduct);
    const skus = this.db
      .prepare(
        `SELECT s.*, p.name AS product_name,
          COALESCE((SELECT SUM(remaining_quantity) FROM stock_lots WHERE sku_id = s.id), 0) AS current_stock
         FROM skus s
         JOIN products p ON p.id = s.product_id
         WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY s.is_active DESC, p.name, s.name`
      )
      .all()
      .map(mapSku);
    const partners = this.db.prepare("SELECT * FROM partners ORDER BY is_active DESC, name").all().map(mapPartner);
    return {
      products,
      skus,
      suppliers: partners.filter((partner) => partner.type === "supplier"),
      customers: partners.filter((partner) => partner.type === "customer")
    };
  }

  createProduct(input: Partial<Product>): Product {
    const date = now();
    const info = this.db
      .prepare(
        `INSERT INTO products (name, code, category, note, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .run(requireText(input.name, "商品名称"), input.code || null, input.category || null, input.note || null, date, date);
    return mapProduct(this.db.prepare("SELECT * FROM products WHERE id = ?").get(info.lastInsertRowid));
  }

  updateProduct(id: number, input: Partial<Product>): Product {
    this.db
      .prepare(
        `UPDATE products
         SET name = ?, code = ?, category = ?, note = ?, is_active = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        requireText(input.name, "商品名称"),
        input.code || null,
        input.category || null,
        input.note || null,
        input.isActive === false ? 0 : 1,
        now(),
        id
      );
    return mapProduct(this.db.prepare("SELECT * FROM products WHERE id = ?").get(id));
  }

  deleteProduct(id: number): void {
    const product = this.db.prepare("SELECT id FROM products WHERE id = ?").get(id);
    if (!product) throw new Error("商品不存在");
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM skus WHERE product_id = ?").get(id) as { count: number };
    if (Number(row.count) > 0) {
      const date = now();
      this.db.transaction(() => {
        this.db.prepare("UPDATE products SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?").run(date, date, id);
        this.db.prepare("UPDATE skus SET is_active = 0, deleted_at = ?, updated_at = ? WHERE product_id = ?").run(date, date, id);
      })();
      return;
    }
    const info = this.db.prepare("DELETE FROM products WHERE id = ?").run(id);
    if (!info.changes) throw new Error("商品不存在");
  }

  createSku(input: Partial<Sku>): Sku {
    const date = now();
    const productId = Number(input.productId);
    if (!productId) throw new Error("请选择商品");
    const info = this.db
      .prepare(
        `INSERT INTO skus
         (product_id, name, sku_code, barcode, unit, default_cost, default_price, low_stock_threshold, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        productId,
        requireText(input.name, "SKU名称"),
        input.skuCode || null,
        input.barcode || null,
        input.unit || "件",
        Number(input.defaultCost ?? 0),
        Number(input.defaultPrice ?? 0),
        Number(input.lowStockThreshold ?? 0),
        date,
        date
      );
    return this.getSku(Number(info.lastInsertRowid));
  }

  updateSku(id: number, input: Partial<Sku>): Sku {
    const productId = Number(input.productId);
    if (!productId) throw new Error("请选择商品");
    this.db
      .prepare(
        `UPDATE skus
         SET product_id = ?, name = ?, sku_code = ?, barcode = ?, unit = ?, default_cost = ?, default_price = ?,
             low_stock_threshold = ?, is_active = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        productId,
        requireText(input.name, "SKU名称"),
        input.skuCode || null,
        input.barcode || null,
        input.unit || "件",
        Number(input.defaultCost ?? 0),
        Number(input.defaultPrice ?? 0),
        Number(input.lowStockThreshold ?? 0),
        input.isActive === false ? 0 : 1,
        now(),
        id
      );
    return this.getSku(id);
  }

  deleteSku(id: number): void {
    const refs = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM inbound_lines WHERE sku_id = ?) AS inboundCount,
          (SELECT COUNT(*) FROM outbound_lines WHERE sku_id = ?) AS outboundCount,
          (SELECT COUNT(*) FROM stock_lots WHERE sku_id = ?) AS lotCount,
          (SELECT COUNT(*) FROM stock_movements WHERE sku_id = ?) AS movementCount`
      )
      .get(id, id, id, id) as { inboundCount: number; outboundCount: number; lotCount: number; movementCount: number };
    const totalRefs = Number(refs.inboundCount) + Number(refs.outboundCount) + Number(refs.lotCount) + Number(refs.movementCount);
    if (totalRefs > 0) {
      const date = now();
      const info = this.db.prepare("UPDATE skus SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?").run(date, date, id);
      if (!info.changes) throw new Error("SKU不存在");
      return;
    }
    const info = this.db.prepare("DELETE FROM skus WHERE id = ?").run(id);
    if (!info.changes) throw new Error("SKU不存在");
  }

  private getSku(id: number): Sku {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS product_name,
          COALESCE((SELECT SUM(remaining_quantity) FROM stock_lots WHERE sku_id = s.id), 0) AS current_stock
         FROM skus s JOIN products p ON p.id = s.product_id WHERE s.id = ?`
      )
      .get(id);
    return mapSku(row);
  }

  createPartner(input: Partial<Partner>): Partner {
    const type = input.type === "customer" ? "customer" : "supplier";
    const isMember = type === "customer" && input.isMember === true ? 1 : 0;
    const memberDiscounts = type === "customer" ? this.normalizeMemberDiscounts(input.memberDiscounts) : [];
    const date = now();
    const info = this.db
      .prepare(
        `INSERT INTO partners (type, name, contact, phone, address, note, is_member, member_discounts, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        type,
        requireText(input.name, "名称"),
        input.contact || null,
        input.phone || null,
        input.address || null,
        input.note || null,
        isMember,
        JSON.stringify(memberDiscounts),
        date,
        date
      );
    return mapPartner(this.db.prepare("SELECT * FROM partners WHERE id = ?").get(info.lastInsertRowid));
  }

  updatePartner(id: number, input: Partial<Partner>): Partner {
    const type = input.type === "customer" ? "customer" : "supplier";
    const isMember = type === "customer" && input.isMember === true ? 1 : 0;
    const memberDiscounts = type === "customer" ? this.normalizeMemberDiscounts(input.memberDiscounts) : [];
    this.db
      .prepare(
        `UPDATE partners
         SET type = ?, name = ?, contact = ?, phone = ?, address = ?, note = ?, is_member = ?, member_discounts = ?, is_active = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        type,
        requireText(input.name, "名称"),
        input.contact || null,
        input.phone || null,
        input.address || null,
        input.note || null,
        isMember,
        JSON.stringify(memberDiscounts),
        input.isActive === false ? 0 : 1,
        now(),
        id
      );
    return mapPartner(this.db.prepare("SELECT * FROM partners WHERE id = ?").get(id));
  }

  deletePartner(id: number): void {
    const refs = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM inbound_orders WHERE supplier_id = ?) AS inboundCount,
          (SELECT COUNT(*) FROM outbound_orders WHERE customer_id = ?) AS outboundCount`
      )
      .get(id, id) as { inboundCount: number; outboundCount: number };
    if (Number(refs.inboundCount) + Number(refs.outboundCount) > 0) {
      throw new Error("该客户或供应商已有单据记录，不能删除。可以将其停用，历史单据会保留。");
    }
    const info = this.db.prepare("DELETE FROM partners WHERE id = ?").run(id);
    if (!info.changes) throw new Error("往来单位不存在");
  }

  private normalizeMemberDiscounts(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => ({
        productName: requireText((item as any).productName, "优惠商品名称"),
        discountAmount: Number((item as any).discountAmount ?? 0)
      }))
      .map((item) => {
        if (!Number.isFinite(item.discountAmount) || item.discountAmount < 0) throw new Error("单件优惠不能小于0");
        return item;
      });
  }

  listInboundOrders(): OrderListItem[] {
    return this.db
      .prepare(
        `SELECT o.*, p.name AS partner_name, 0 AS total_cost, 0 AS total_profit
         FROM inbound_orders o
         LEFT JOIN partners p ON p.id = o.supplier_id
         ORDER BY o.created_at DESC`
      )
      .all()
      .map(mapOrder);
  }

  createInboundOrder(input: InboundOrderInput): OrderListItem {
    if (!input.lines?.length) throw new Error("请至少添加一条入库明细");
    const date = now();
    const orderDate = input.orderDate || date.slice(0, 10);
    const create = this.db.transaction(() => {
      const total = input.lines.reduce((sum, line) => {
        return sum + requirePositive(line.quantity, "入库数量") * requirePositive(line.unitCost, "采购单价");
      }, 0);
      const orderInfo = this.db
        .prepare(
          `INSERT INTO inbound_orders (order_no, supplier_id, status, order_date, note, total_amount, created_at)
           VALUES (?, ?, 'draft', ?, ?, ?, ?)`
        )
        .run(makeOrderNo("IN"), input.supplierId || null, orderDate, input.note || null, roundMoney(total), date);
      const orderId = Number(orderInfo.lastInsertRowid);
      const insertLine = this.db.prepare(
        `INSERT INTO inbound_lines (order_id, sku_id, quantity, unit_cost, amount, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const line of input.lines) {
        const quantity = requirePositive(line.quantity, "入库数量");
        const unitCost = requirePositive(line.unitCost, "采购单价");
        insertLine.run(orderId, line.skuId, quantity, unitCost, roundMoney(quantity * unitCost), line.note || null);
      }
      return orderId;
    });
    const orderId = create();
    return this.getInboundOrder(orderId);
  }

  approveInboundOrder(id: number) {
    const approve = this.db.transaction(() => {
      const order: any = this.db.prepare("SELECT * FROM inbound_orders WHERE id = ?").get(id);
      if (!order) throw new Error("入库单不存在");
      if (order.status !== "draft") throw new Error("只有草稿入库单可以审核");
      const lines: any[] = this.db.prepare("SELECT * FROM inbound_lines WHERE order_id = ?").all(id);
      if (!lines.length) throw new Error("入库单没有明细");
      const approvedAt = now();
      const insertLot = this.db.prepare(
        `INSERT INTO stock_lots
         (sku_id, inbound_line_id, inbound_order_id, lot_no, received_quantity, remaining_quantity, unit_cost, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertMovement = this.db.prepare(
        `INSERT INTO stock_movements
         (sku_id, type, quantity, unit_cost, cost_amount, sales_amount, profit_amount, lot_id, order_type, order_id, line_id, note, occurred_at)
         VALUES (?, 'in', ?, ?, ?, 0, 0, ?, 'inbound', ?, ?, ?, ?)`
      );
      for (const line of lines) {
        const lotInfo = insertLot.run(
          line.sku_id,
          line.id,
          id,
          `${order.order_no}-${line.id}`,
          line.quantity,
          line.quantity,
          line.unit_cost,
          order.order_date,
          approvedAt
        );
        insertMovement.run(
          line.sku_id,
          line.quantity,
          line.unit_cost,
          roundMoney(line.quantity * line.unit_cost),
          lotInfo.lastInsertRowid,
          id,
          line.id,
          line.note,
          approvedAt
        );
      }
      this.db.prepare("UPDATE inbound_orders SET status = 'approved', approved_at = ? WHERE id = ?").run(approvedAt, id);
    });
    approve();
  }

  voidInboundOrder(id: number) {
    const voidOrder = this.db.transaction(() => {
      const order: any = this.db.prepare("SELECT * FROM inbound_orders WHERE id = ?").get(id);
      if (!order) throw new Error("入库单不存在");
      if (order.status === "voided") return;
      const voidedAt = now();
      if (order.status === "approved") {
        const consumed: any = this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM stock_lots
             WHERE inbound_order_id = ? AND remaining_quantity < received_quantity`
          )
          .get(id);
        if (Number(consumed.count) > 0) throw new Error("该入库批次已有出库记录，不能直接作废");
        this.db.prepare("DELETE FROM stock_movements WHERE order_type = 'inbound' AND order_id = ?").run(id);
        this.db.prepare("DELETE FROM stock_lots WHERE inbound_order_id = ?").run(id);
      }
      this.db.prepare("UPDATE inbound_orders SET status = 'voided', voided_at = ? WHERE id = ?").run(voidedAt, id);
    });
    voidOrder();
  }

  private getInboundOrder(id: number): OrderListItem {
    return mapOrder(
      this.db
        .prepare(
          `SELECT o.*, p.name AS partner_name, 0 AS total_cost, 0 AS total_profit
           FROM inbound_orders o
           LEFT JOIN partners p ON p.id = o.supplier_id
           WHERE o.id = ?`
        )
        .get(id)
    );
  }

  listOutboundOrders(): OrderListItem[] {
    return this.db
      .prepare(
        `SELECT o.*, p.name AS partner_name
         FROM outbound_orders o
         LEFT JOIN partners p ON p.id = o.customer_id
         ORDER BY o.created_at DESC`
      )
      .all()
      .map(mapOrder);
  }

  createOutboundOrder(input: OutboundOrderInput): OrderListItem {
    if (!input.lines?.length) throw new Error("请至少添加一条出库明细");
    const date = now();
    const orderDate = input.orderDate || date.slice(0, 10);
    const create = this.db.transaction(() => {
      const total = input.lines.reduce((sum, line) => {
        return sum + requirePositive(line.quantity, "出库数量") * requirePositive(line.unitPrice, "销售单价");
      }, 0);
      const orderInfo = this.db
        .prepare(
          `INSERT INTO outbound_orders
           (order_no, customer_id, status, order_date, note, total_amount, total_cost, total_profit, created_at)
           VALUES (?, ?, 'draft', ?, ?, ?, 0, 0, ?)`
        )
        .run(makeOrderNo("OUT"), input.customerId || null, orderDate, input.note || null, roundMoney(total), date);
      const orderId = Number(orderInfo.lastInsertRowid);
      const insertLine = this.db.prepare(
        `INSERT INTO outbound_lines (order_id, sku_id, quantity, unit_price, amount, cost_amount, profit_amount, note)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
      );
      for (const line of input.lines) {
        const quantity = requirePositive(line.quantity, "出库数量");
        const unitPrice = requirePositive(line.unitPrice, "销售单价");
        insertLine.run(orderId, line.skuId, quantity, unitPrice, roundMoney(quantity * unitPrice), line.note || null);
      }
      return orderId;
    });
    const orderId = create();
    return this.getOutboundOrder(orderId);
  }

  approveOutboundOrder(id: number) {
    const approve = this.db.transaction(() => {
      const order: any = this.db.prepare("SELECT * FROM outbound_orders WHERE id = ?").get(id);
      if (!order) throw new Error("出库单不存在");
      if (order.status !== "draft") throw new Error("只有草稿出库单可以审核");
      const lines: any[] = this.db.prepare("SELECT * FROM outbound_lines WHERE order_id = ?").all(id);
      if (!lines.length) throw new Error("出库单没有明细");

      for (const line of lines) {
        const stock: any = this.db
          .prepare("SELECT COALESCE(SUM(remaining_quantity), 0) AS qty FROM stock_lots WHERE sku_id = ? AND stock_location = 'storefront'")
          .get(line.sku_id);
        if (Number(stock.qty) < Number(line.quantity)) {
          const sku = this.getSku(line.sku_id);
          throw new Error(`${sku.productName} / ${sku.name} 库存不足，当前 ${stock.qty}，需要 ${line.quantity}`);
        }
      }

      const approvedAt = now();
      let orderCost = 0;
      let orderProfit = 0;
      const updateLot = this.db.prepare("UPDATE stock_lots SET remaining_quantity = remaining_quantity - ? WHERE id = ?");
      const insertConsumption = this.db.prepare(
        `INSERT INTO lot_consumptions (outbound_line_id, lot_id, quantity, unit_cost, cost_amount)
         VALUES (?, ?, ?, ?, ?)`
      );
      const insertMovement = this.db.prepare(
        `INSERT INTO stock_movements
         (sku_id, type, quantity, unit_cost, unit_price, cost_amount, sales_amount, profit_amount,
          lot_id, order_type, order_id, line_id, note, occurred_at)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?)`
      );

      for (const line of lines) {
        let remaining = Number(line.quantity);
        let lineCost = 0;
        const lots: any[] = this.db
          .prepare(
            `SELECT * FROM stock_lots
             WHERE sku_id = ? AND stock_location = 'storefront' AND remaining_quantity > 0
             ORDER BY received_at ASC, id ASC`
          )
          .all(line.sku_id);

        for (const lot of lots) {
          if (remaining <= 0) break;
          const takeQty = Math.min(remaining, Number(lot.remaining_quantity));
          const costAmount = roundMoney(takeQty * Number(lot.unit_cost));
          const salesAmount = roundMoney(takeQty * Number(line.unit_price));
          const profitAmount = roundMoney(salesAmount - costAmount);
          updateLot.run(takeQty, lot.id);
          insertConsumption.run(line.id, lot.id, takeQty, lot.unit_cost, costAmount);
          insertMovement.run(
            line.sku_id,
            -takeQty,
            lot.unit_cost,
            line.unit_price,
            costAmount,
            salesAmount,
            profitAmount,
            lot.id,
            id,
            line.id,
            line.note,
            approvedAt
          );
          lineCost = roundMoney(lineCost + costAmount);
          remaining = roundMoney(remaining - takeQty);
        }

        const lineProfit = roundMoney(Number(line.amount) - lineCost);
        this.db.prepare("UPDATE outbound_lines SET cost_amount = ?, profit_amount = ? WHERE id = ?").run(lineCost, lineProfit, line.id);
        orderCost = roundMoney(orderCost + lineCost);
        orderProfit = roundMoney(orderProfit + lineProfit);
      }

      this.db
        .prepare("UPDATE outbound_orders SET status = 'approved', total_cost = ?, total_profit = ?, approved_at = ? WHERE id = ?")
        .run(orderCost, orderProfit, approvedAt, id);
    });
    approve();
  }

  voidOutboundOrder(id: number) {
    const voidOrder = this.db.transaction(() => {
      const order: any = this.db.prepare("SELECT * FROM outbound_orders WHERE id = ?").get(id);
      if (!order) throw new Error("出库单不存在");
      if (order.status === "voided") return;
      const voidedAt = now();
      if (order.status === "approved") {
        const consumptions: any[] = this.db
          .prepare(
            `SELECT c.*
             FROM lot_consumptions c
             JOIN outbound_lines l ON l.id = c.outbound_line_id
             WHERE l.order_id = ?`
          )
          .all(id);
        const restore = this.db.prepare("UPDATE stock_lots SET remaining_quantity = remaining_quantity + ? WHERE id = ?");
        for (const consumption of consumptions) {
          restore.run(consumption.quantity, consumption.lot_id);
        }
        this.db.prepare("DELETE FROM stock_movements WHERE order_type = 'outbound' AND order_id = ?").run(id);
        this.db
          .prepare("DELETE FROM lot_consumptions WHERE outbound_line_id IN (SELECT id FROM outbound_lines WHERE order_id = ?)")
          .run(id);
      }
      this.db.prepare("UPDATE outbound_orders SET status = 'voided', voided_at = ? WHERE id = ?").run(voidedAt, id);
    });
    voidOrder();
  }

  assertOutboundOrderReadyToApprove(id: number) {
    const order: any = this.db.prepare("SELECT * FROM outbound_orders WHERE id = ?").get(id);
    if (!order) throw new Error("出库单不存在");
    if (order.status !== "draft") throw new Error("只有草稿出库单可以打印并出库");
    const lines: any[] = this.db.prepare("SELECT * FROM outbound_lines WHERE order_id = ?").all(id);
    if (!lines.length) throw new Error("出库单没有明细");
    for (const line of lines) {
      const stock: any = this.db
        .prepare("SELECT COALESCE(SUM(remaining_quantity), 0) AS qty FROM stock_lots WHERE sku_id = ? AND stock_location = 'storefront'")
        .get(line.sku_id);
      if (Number(stock.qty) < Number(line.quantity)) {
        const sku = this.getSku(line.sku_id);
        throw new Error(`${sku.productName} / ${sku.name} 库存不足，当前 ${stock.qty}，需要 ${line.quantity}`);
      }
    }
  }

  getOutboundReceipt(id: number): OutboundReceipt {
    const order: any = this.db
      .prepare(
        `SELECT o.*, p.name AS customer_name
         FROM outbound_orders o
         LEFT JOIN partners p ON p.id = o.customer_id
         WHERE o.id = ?`
      )
      .get(id);
    if (!order) throw new Error("出库单不存在");
    const rawLines: any[] = this.db
      .prepare(
        `SELECT
          l.id AS lineId,
          l.sku_id AS skuId,
          p.name AS productName,
          s.name AS skuName,
          s.sku_code AS skuCode,
          s.unit AS unit,
          l.quantity AS quantity,
          l.unit_price AS unitPrice,
          l.amount AS amount,
          l.cost_amount AS costAmount,
          l.profit_amount AS profitAmount
         FROM outbound_lines l
         JOIN skus s ON s.id = l.sku_id
         JOIN products p ON p.id = s.product_id
         WHERE l.order_id = ?
         ORDER BY l.id ASC`
      )
      .all(id);
    const estimatedCosts = order.status === "draft" ? this.estimateOutboundLineCosts(rawLines) : new Map<number, number>();
    const lines = rawLines.map((line: any) => {
      const costAmount = order.status === "draft" ? estimatedCosts.get(line.lineId) ?? 0 : Number(line.costAmount ?? 0);
      return {
        productName: line.productName,
        skuName: line.skuName,
        skuCode: line.skuCode,
        quantity: Number(line.quantity),
        unit: line.unit,
        unitPrice: Number(line.unitPrice),
        amount: Number(line.amount),
        costAmount: roundMoney(costAmount),
        profitAmount: roundMoney(Number(line.amount) - costAmount)
      };
    });
    return {
      orderId: order.id,
      orderNo: order.order_no,
      status: order.status,
      customerName: order.customer_name,
      orderDate: order.order_date,
      note: order.note,
      totalAmount: Number(order.total_amount ?? 0),
      lines
    };
  }

  private estimateOutboundLineCosts(lines: any[]): Map<number, number> {
    const result = new Map<number, number>();
    const lotsBySku = new Map<number, any[]>();
    const remainingByLot = new Map<number, number>();
    for (const line of lines) {
      if (!lotsBySku.has(line.skuId)) {
        const lots: any[] = this.db
          .prepare(
            `SELECT id, remaining_quantity, unit_cost
             FROM stock_lots
             WHERE sku_id = ? AND stock_location = 'storefront' AND remaining_quantity > 0
             ORDER BY received_at ASC, id ASC`
          )
          .all(line.skuId);
        lotsBySku.set(line.skuId, lots);
        for (const lot of lots) {
          remainingByLot.set(lot.id, Number(lot.remaining_quantity));
        }
      }
      let remaining = Number(line.quantity);
      let cost = 0;
      for (const lot of lotsBySku.get(line.skuId) ?? []) {
        if (remaining <= 0) break;
        const lotRemaining = remainingByLot.get(lot.id) ?? 0;
        const take = Math.min(remaining, lotRemaining);
        if (take <= 0) continue;
        remainingByLot.set(lot.id, roundMoney(lotRemaining - take));
        cost = roundMoney(cost + take * Number(lot.unit_cost));
        remaining = roundMoney(remaining - take);
      }
      result.set(line.lineId, cost);
    }
    return result;
  }

  transferToStorefront(input: StockTransferInput) {
    const transfer = this.db.transaction(() => {
      const skuId = Number(input.skuId);
      const quantity = requirePositive(input.quantity, "调拨数量");
      const stock: any = this.db
        .prepare("SELECT COALESCE(SUM(remaining_quantity), 0) AS qty FROM stock_lots WHERE sku_id = ? AND stock_location = 'warehouse'")
        .get(skuId);
      if (Number(stock.qty) < quantity) {
        const sku = this.getSku(skuId);
        throw new Error(`${sku.productName} / ${sku.name} 仓库库存不足，当前 ${stock.qty}，需要 ${quantity}`);
      }

      const occurredAt = now();
      const lots: any[] = this.db
        .prepare(
          `SELECT *
           FROM stock_lots
           WHERE sku_id = ? AND stock_location = 'warehouse' AND remaining_quantity > 0
           ORDER BY received_at ASC, id ASC`
        )
        .all(skuId);
      const updateWarehouseLot = this.db.prepare("UPDATE stock_lots SET remaining_quantity = remaining_quantity - ? WHERE id = ?");
      const insertStorefrontLot = this.db.prepare(
        `INSERT INTO stock_lots
         (sku_id, inbound_line_id, inbound_order_id, lot_no, stock_location, received_quantity, remaining_quantity, unit_cost, received_at, created_at)
         VALUES (?, ?, ?, ?, 'storefront', ?, ?, ?, ?, ?)`
      );
      const insertMovement = this.db.prepare(
        `INSERT INTO stock_movements
         (sku_id, type, quantity, unit_cost, cost_amount, sales_amount, profit_amount, lot_id, order_type, order_id, line_id, note, occurred_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'transfer', 0, 0, ?, ?)`
      );

      let remaining = quantity;
      for (const lot of lots) {
        if (remaining <= 0) break;
        const takeQty = Math.min(remaining, Number(lot.remaining_quantity));
        const costAmount = roundMoney(takeQty * Number(lot.unit_cost));
        updateWarehouseLot.run(takeQty, lot.id);
        insertMovement.run(skuId, "out", -takeQty, lot.unit_cost, costAmount, lot.id, input.note || "仓库调拨到门市", occurredAt);
        const newLot = insertStorefrontLot.run(
          skuId,
          lot.inbound_line_id,
          lot.inbound_order_id,
          `${lot.lot_no}-门市-${Date.now()}`,
          takeQty,
          takeQty,
          lot.unit_cost,
          lot.received_at,
          occurredAt
        );
        insertMovement.run(skuId, "in", takeQty, lot.unit_cost, costAmount, newLot.lastInsertRowid, input.note || "仓库调拨到门市", occurredAt);
        remaining = roundMoney(remaining - takeQty);
      }
    });
    transfer();
  }

  addStorefrontStock(input: StockIncreaseInput) {
    const addStock = this.db.transaction(() => {
      const skuId = Number(input.skuId);
      const quantity = requirePositive(input.quantity, "加库存数量");
      const unitCost = requirePositive(input.unitCost, "成本价");
      this.getSku(skuId);

      const date = now();
      const orderDate = date.slice(0, 10);
      const amount = roundMoney(quantity * unitCost);
      const orderInfo = this.db
        .prepare(
          `INSERT INTO inbound_orders (order_no, supplier_id, status, order_date, note, total_amount, created_at, approved_at)
           VALUES (?, NULL, 'approved', ?, ?, ?, ?, ?)`
        )
        .run(makeOrderNo("IN"), orderDate, input.note || "门市加库存", amount, date, date);
      const orderId = Number(orderInfo.lastInsertRowid);
      const lineInfo = this.db
        .prepare(
          `INSERT INTO inbound_lines (order_id, sku_id, quantity, unit_cost, amount, note)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(orderId, skuId, quantity, unitCost, amount, input.note || "门市加库存");
      const lineId = Number(lineInfo.lastInsertRowid);
      const lotInfo = this.db
        .prepare(
          `INSERT INTO stock_lots
           (sku_id, inbound_line_id, inbound_order_id, lot_no, stock_location, received_quantity, remaining_quantity, unit_cost, received_at, created_at)
           VALUES (?, ?, ?, ?, 'storefront', ?, ?, ?, ?, ?)`
        )
        .run(skuId, lineId, orderId, `门市-${orderId}-${lineId}`, quantity, quantity, unitCost, orderDate, date);
      this.db
        .prepare(
          `INSERT INTO stock_movements
           (sku_id, type, quantity, unit_cost, cost_amount, sales_amount, profit_amount, lot_id, order_type, order_id, line_id, note, occurred_at)
           VALUES (?, 'in', ?, ?, ?, 0, 0, ?, 'storefront_increase', ?, ?, ?, ?)`
        )
        .run(skuId, quantity, unitCost, amount, lotInfo.lastInsertRowid, orderId, lineId, input.note || "门市加库存", date);
    });
    addStock();
  }

  private getOutboundOrder(id: number): OrderListItem {
    return mapOrder(
      this.db
        .prepare(
          `SELECT o.*, p.name AS partner_name
           FROM outbound_orders o
           LEFT JOIN partners p ON p.id = o.customer_id
           WHERE o.id = ?`
        )
        .get(id)
    );
  }

  getInventory(): InventoryRow[] {
    return this.db
      .prepare(
        `SELECT
          s.id AS skuId,
          p.name AS productName,
          s.name AS skuName,
          s.sku_code AS skuCode,
          s.unit AS unit,
          s.default_cost AS defaultCost,
          s.default_price AS defaultPrice,
          s.low_stock_threshold AS lowStockThreshold,
          COALESCE(SUM(CASE WHEN l.stock_location = 'warehouse' THEN l.remaining_quantity ELSE 0 END), 0) AS warehouseStock,
          COALESCE(SUM(CASE WHEN l.stock_location = 'storefront' THEN l.remaining_quantity ELSE 0 END), 0) AS storefrontStock,
          COALESCE(SUM(l.remaining_quantity), 0) AS currentStock,
          COALESCE(SUM(l.remaining_quantity * l.unit_cost), 0) AS stockValue
         FROM skus s
         JOIN products p ON p.id = s.product_id
         LEFT JOIN stock_lots l ON l.sku_id = s.id
         WHERE s.is_active = 1 AND s.deleted_at IS NULL AND p.deleted_at IS NULL
         GROUP BY s.id
         ORDER BY p.name, s.name`
      )
      .all()
      .map((row: any) => ({
        skuId: row.skuId,
        productName: row.productName,
        skuName: row.skuName,
        skuCode: row.skuCode,
        unit: row.unit,
        defaultCost: Number(row.defaultCost),
        defaultPrice: Number(row.defaultPrice),
        lowStockThreshold: Number(row.lowStockThreshold),
        warehouseStock: Number(row.warehouseStock),
        storefrontStock: Number(row.storefrontStock),
        currentStock: Number(row.currentStock),
        stockValue: roundMoney(Number(row.stockValue)),
        isLowStock: Number(row.storefrontStock) <= Number(row.lowStockThreshold)
      }));
  }

  getDashboard(): Dashboard {
    const inventory = this.getInventory();
    const sales: any = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_amount), 0) AS salesAmount, COALESCE(SUM(total_profit), 0) AS profitAmount
         FROM outbound_orders
         WHERE status = 'approved'`
      )
      .get();
    return {
      skuCount: inventory.length,
      totalStock: roundMoney(inventory.reduce((sum, row) => sum + row.currentStock, 0)),
      stockValue: roundMoney(inventory.reduce((sum, row) => sum + row.stockValue, 0)),
      lowStockCount: inventory.filter((row) => row.isLowStock).length,
      salesAmount: roundMoney(Number(sales.salesAmount)),
      profitAmount: roundMoney(Number(sales.profitAmount))
    };
  }

  getMovements(): MovementRow[] {
    return this.db
      .prepare(
        `SELECT
          m.id,
          m.sku_id AS skuId,
          p.name AS productName,
          s.name AS skuName,
          m.type,
          m.quantity,
          m.unit_cost AS unitCost,
          m.unit_price AS unitPrice,
          m.cost_amount AS costAmount,
          m.sales_amount AS salesAmount,
          m.profit_amount AS profitAmount,
          m.order_type AS orderType,
          COALESCE(io.order_no, oo.order_no) AS orderNo,
          m.note,
          m.occurred_at AS occurredAt
         FROM stock_movements m
         JOIN skus s ON s.id = m.sku_id
         JOIN products p ON p.id = s.product_id
         LEFT JOIN inbound_orders io ON m.order_type = 'inbound' AND io.id = m.order_id
         LEFT JOIN outbound_orders oo ON m.order_type = 'outbound' AND oo.id = m.order_id
         ORDER BY m.occurred_at DESC, m.id DESC`
      )
      .all()
      .map((row: any) => ({
        id: row.id,
        skuId: row.skuId,
        productName: row.productName,
        skuName: row.skuName,
        type: row.type,
        quantity: Number(row.quantity),
        unitCost: row.unitCost === null ? null : Number(row.unitCost),
        unitPrice: row.unitPrice === null ? null : Number(row.unitPrice),
        costAmount: Number(row.costAmount),
        salesAmount: Number(row.salesAmount),
        profitAmount: Number(row.profitAmount),
        orderType: row.orderType,
        orderNo: row.orderNo,
        note: row.note,
        occurredAt: row.occurredAt
      }));
  }

  getProfitReport(): ProfitRow[] {
    return this.db
      .prepare(
        `SELECT
          l.sku_id AS skuId,
          p.name AS productName,
          s.name AS skuName,
          COALESCE(SUM(l.quantity), 0) AS quantity,
          COALESCE(SUM(l.amount), 0) AS salesAmount,
          COALESCE(SUM(l.cost_amount), 0) AS costAmount,
          COALESCE(SUM(l.profit_amount), 0) AS profitAmount
         FROM outbound_lines l
         JOIN outbound_orders o ON o.id = l.order_id
         JOIN skus s ON s.id = l.sku_id
         JOIN products p ON p.id = s.product_id
         WHERE o.status = 'approved'
         GROUP BY l.sku_id
         ORDER BY profitAmount DESC`
      )
      .all()
      .map((row: any) => ({
        skuId: row.skuId,
        productName: row.productName,
        skuName: row.skuName,
        quantity: Number(row.quantity),
        salesAmount: Number(row.salesAmount),
        costAmount: Number(row.costAmount),
        profitAmount: Number(row.profitAmount)
      }));
  }

  exportExcel(): string {
    const catalog = this.getCatalog();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(catalog.products), "商品");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(catalog.skus), "SKU");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(this.getInventory()), "库存现状");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(this.listInboundOrders()), "入库单");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(this.listOutboundOrders()), "出库单");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(this.getMovements()), "出入库明细");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(this.getProfitReport()), "利润报表");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(this.exportDir, `库存导出-${stamp}.xlsx`);
    XLSX.writeFile(workbook, target);
    return target;
  }
}
