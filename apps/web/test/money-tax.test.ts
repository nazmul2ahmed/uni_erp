import { describe, expect, it } from "vitest";
import { allocateProportionally, decimalToUnits, previewTax, taxForAmount, unitsToDecimal } from "../lib/money";

describe("tax-exclusive money calculations", () => {
  it("adds tax after line and allocated order discounts without floating point arithmetic", () => {
    const result = previewTax(
      [
        { quantity: "2", unitPrice: "100", lineDiscount: "10", taxRate: "10" },
        { quantity: "1", unitPrice: "50", lineDiscount: "0", taxRate: "5" },
      ],
      "10",
    );

    expect(unitsToDecimal(result.subtotalUnits)).toBe("250");
    expect(unitsToDecimal(result.discountUnits)).toBe("20");
    expect(unitsToDecimal(result.taxUnits)).toBe("20.6041");
    expect(unitsToDecimal(result.totalUnits)).toBe("250.6041");
  });

  it("rounds tax half-up to the money scale and conserves allocated discounts", () => {
    expect(unitsToDecimal(taxForAmount(decimalToUnits("0.05"), "10"))).toBe("0.005");
    expect(allocateProportionally(7n, [1n, 2n, 0n])).toEqual([2n, 5n, 0n]);
    expect(allocateProportionally(0n, [0n, 0n])).toEqual([0n, 0n]);
  });

  it("rejects discounts that exceed the sale subtotal", () => {
    expect(() => previewTax(
      [{ quantity: "1", unitPrice: "10", lineDiscount: "1", taxRate: "5" }],
      "10",
    )).toThrow("Discounts cannot exceed the subtotal");
  });
});
