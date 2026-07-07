import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InventoryStore } from "../src/main/inventory-store";

let tempDir = "";
let store: InventoryStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kucun-test-"));
  store = new InventoryStore(path.join(tempDir, "inventory.sqlite"), tempDir);
});

afterEach(() => {
  store?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createSku(defaultPrice = 10) {
  const product = store.createProduct({ name: "测试商品", code: "P001" });
  return store.createSku({
    productId: product.id,
    name: "红色/L",
    skuCode: "SKU001",
    unit: "件",
    defaultPrice,
    lowStockThreshold: 2
  });
}

describe("InventoryStore", () => {
  it("creates default admin and manages login users", () => {
    const admin = store.login({ username: "admin", password: "admin123" });
    expect(admin).toMatchObject({ username: "admin", role: "admin", isActive: true });

    const clerk = store.createUser({ username: "menshi", password: "123456", role: "storefront" });
    expect(clerk).toMatchObject({ username: "menshi", role: "storefront", isActive: true });
    expect(store.login({ username: "menshi", password: "123456" }).role).toBe("storefront");

    const updated = store.updateUser(clerk.id, { username: "cangku", password: "", role: "warehouse", isActive: true });
    expect(updated).toMatchObject({ username: "cangku", role: "warehouse", isActive: true });

    store.deleteUser(updated.id);
    expect(() => store.login({ username: "cangku", password: "123456" })).toThrow("用户名或密码不正确");
    expect(() => store.deleteUser(admin.id)).toThrow("至少保留");
  });

  it("uses FIFO lots to calculate outbound cost and profit", () => {
    const sku = createSku(10);
    const inbound = store.createInboundOrder({
      orderDate: "2026-07-04",
      lines: [
        { skuId: sku.id, quantity: 10, unitCost: 5 },
        { skuId: sku.id, quantity: 10, unitCost: 7 }
      ]
    });
    store.approveInboundOrder(inbound.id);
    store.transferToStorefront({ skuId: sku.id, quantity: 15 });

    const outbound = store.createOutboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 15, unitPrice: 10 }]
    });
    store.approveOutboundOrder(outbound.id);

    const [profit] = store.getProfitReport();
    const [inventory] = store.getInventory();

    expect(profit.quantity).toBe(15);
    expect(profit.salesAmount).toBe(150);
    expect(profit.costAmount).toBe(85);
    expect(profit.profitAmount).toBe(65);
    expect(inventory.currentStock).toBe(5);
    expect(inventory.warehouseStock).toBe(5);
    expect(inventory.storefrontStock).toBe(0);
    expect(inventory.stockValue).toBe(35);
  });

  it("blocks outbound approval when stock is insufficient", () => {
    const sku = createSku();
    const inbound = store.createInboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 3, unitCost: 6 }]
    });
    store.approveInboundOrder(inbound.id);

    const outbound = store.createOutboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 4, unitPrice: 10 }]
    });

    expect(() => store.approveOutboundOrder(outbound.id)).toThrow("库存不足");
    expect(store.getInventory()[0].currentStock).toBe(3);
    expect(store.getInventory()[0].warehouseStock).toBe(3);
    expect(store.getInventory()[0].storefrontStock).toBe(0);
  });

  it("prepares receipt data and blocks print flow before stock is enough", () => {
    const sku = createSku(12);
    const outbound = store.createOutboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 2, unitPrice: 12 }]
    });

    expect(() => store.assertOutboundOrderReadyToApprove(outbound.id)).toThrow("库存不足");

    const inbound = store.createInboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 2, unitCost: 5 }]
    });
    store.approveInboundOrder(inbound.id);
    store.transferToStorefront({ skuId: sku.id, quantity: 2 });

    expect(() => store.assertOutboundOrderReadyToApprove(outbound.id)).not.toThrow();
    const receipt = store.getOutboundReceipt(outbound.id);
    expect(receipt.orderNo).toBe(outbound.orderNo);
    expect(receipt.totalAmount).toBe(24);
    expect(receipt.lines).toMatchObject([{ productName: "测试商品", skuName: "红色/L", quantity: 2, unitPrice: 12, amount: 24, costAmount: 10, profitAmount: 14 }]);
  });

  it("restores consumed lots when an approved outbound order is voided", () => {
    const sku = createSku();
    const inbound = store.createInboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 8, unitCost: 4 }]
    });
    store.approveInboundOrder(inbound.id);
    store.transferToStorefront({ skuId: sku.id, quantity: 5 });

    const outbound = store.createOutboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 5, unitPrice: 9 }]
    });
    store.approveOutboundOrder(outbound.id);
    expect(store.getInventory()[0].currentStock).toBe(3);
    expect(store.getInventory()[0].warehouseStock).toBe(3);
    expect(store.getInventory()[0].storefrontStock).toBe(0);

    store.voidOutboundOrder(outbound.id);

    expect(store.getInventory()[0].currentStock).toBe(8);
    expect(store.getInventory()[0].warehouseStock).toBe(3);
    expect(store.getInventory()[0].storefrontStock).toBe(5);
    expect(store.getProfitReport()).toHaveLength(0);
  });

  it("adds stock directly to storefront without changing warehouse stock", () => {
    const sku = createSku(20);

    store.addStorefrontStock({ skuId: sku.id, quantity: 4, unitCost: 8 });

    let inventory = store.getInventory()[0];
    expect(inventory.warehouseStock).toBe(0);
    expect(inventory.storefrontStock).toBe(4);
    expect(inventory.currentStock).toBe(4);

    const outbound = store.createOutboundOrder({
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 3, unitPrice: 20 }]
    });
    store.approveOutboundOrder(outbound.id);

    inventory = store.getInventory()[0];
    expect(inventory.warehouseStock).toBe(0);
    expect(inventory.storefrontStock).toBe(1);
    expect(store.getProfitReport()[0].profitAmount).toBe(36);
  });

  it("saves member customer item discounts", () => {
    const customer = store.createPartner({
      type: "customer",
      name: "会员客户",
      phone: "13800000000",
      isMember: true,
      memberDiscounts: [{ productName: "测试商品", discountAmount: 5 }]
    });

    expect(customer.isMember).toBe(true);
    expect(customer.memberDiscounts).toEqual([{ productName: "测试商品", discountAmount: 5 }]);
    expect(store.getCatalog().customers[0]).toMatchObject({
      name: "会员客户",
      isMember: true,
      memberDiscounts: [{ productName: "测试商品", discountAmount: 5 }]
    });

    const updated = store.updatePartner(customer.id, {
      ...customer,
      memberDiscounts: [{ productName: "测试商品", discountAmount: 8 }]
    });

    expect(updated.memberDiscounts).toEqual([{ productName: "测试商品", discountAmount: 8 }]);
  });

  it("deletes unused catalog records and hides stocked SKUs without removing history", () => {
    const product = store.createProduct({ name: "可删除商品", code: "P-DEL" });
    const sku = store.createSku({ productId: product.id, name: "可删除SKU", skuCode: "SKU-DEL", unit: "件" });

    store.deleteSku(sku.id);
    store.deleteProduct(product.id);

    expect(store.getCatalog().skus.some((item) => item.id === sku.id)).toBe(false);
    expect(store.getCatalog().products.some((item) => item.id === product.id)).toBe(false);

    const usedSku = createSku();
    store.addStorefrontStock({ skuId: usedSku.id, quantity: 1, unitCost: 5 });

    store.deleteSku(usedSku.id);

    expect(store.getCatalog().skus.some((item) => item.id === usedSku.id)).toBe(false);
    expect(store.getInventory().some((item) => item.skuId === usedSku.id)).toBe(false);
    expect(store.getMovements().some((item) => item.skuId === usedSku.id)).toBe(true);
  });

  it("hides products with stocked SKUs and keeps movement history", () => {
    const sku = createSku();
    store.addStorefrontStock({ skuId: sku.id, quantity: 2, unitCost: 6 });

    store.deleteProduct(sku.productId);

    expect(store.getCatalog().products.some((item) => item.id === sku.productId)).toBe(false);
    expect(store.getCatalog().skus.some((item) => item.id === sku.id)).toBe(false);
    expect(store.getInventory().some((item) => item.skuId === sku.id)).toBe(false);
    expect(store.getMovements().some((item) => item.skuId === sku.id)).toBe(true);
  });

  it("deletes unused partners and blocks partners with order history", () => {
    const supplier = store.createPartner({ type: "supplier", name: "可删除供应商" });
    const customer = store.createPartner({ type: "customer", name: "可删除客户" });

    store.deletePartner(supplier.id);
    store.deletePartner(customer.id);

    expect(store.getCatalog().suppliers.some((item) => item.id === supplier.id)).toBe(false);
    expect(store.getCatalog().customers.some((item) => item.id === customer.id)).toBe(false);

    const usedSupplier = store.createPartner({ type: "supplier", name: "已用供应商" });
    const sku = createSku();
    store.createInboundOrder({
      supplierId: usedSupplier.id,
      orderDate: "2026-07-04",
      lines: [{ skuId: sku.id, quantity: 1, unitCost: 5 }]
    });

    expect(() => store.deletePartner(usedSupplier.id)).toThrow("不能删除");
  });
});
