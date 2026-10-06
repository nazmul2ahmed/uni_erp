export const moneyScale = 10000n;

export function decimalToUnits(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(normalized)) {
    throw new Error("Invalid decimal amount");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * moneyScale + BigInt(fraction.padEnd(4, "0"));
}

export function unitsToDecimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const whole = absolute / moneyScale;
  const fraction = (absolute % moneyScale).toString().padStart(4, "0").replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("Invalid non-negative ratio");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function multiplyToMoneyUnits(quantityUnits: bigint, priceUnits: bigint): bigint {
  return roundRatio(quantityUnits * priceUnits, moneyScale);
}

export function taxForAmount(taxableAmountUnits: bigint, rate: string): bigint {
  return roundRatio(taxableAmountUnits * decimalToUnits(rate), 100n * moneyScale);
}

export function allocateProportionally(totalUnits: bigint, weights: bigint[]): bigint[] {
  if (totalUnits < 0n || weights.some((weight) => weight < 0n)) {
    throw new Error("Cannot allocate negative amounts");
  }
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalUnits === 0n) return weights.map(() => 0n);
  if (weightTotal === 0n) throw new Error("Cannot allocate against zero total weight");

  let remaining = totalUnits;
  let remainingWeight = weightTotal;
  return weights.map((weight, index) => {
    if (weight === 0n) return 0n;
    const allocation = index === weights.length - 1 || remainingWeight === weight
      ? remaining
      : (remaining * weight) / remainingWeight;
    remaining -= allocation;
    remainingWeight -= weight;
    return allocation;
  });
}

export type TaxPreviewLine = {
  quantity: string;
  unitPrice: string;
  lineDiscount: string;
  taxRate: string;
};

export function previewTax(
  lines: TaxPreviewLine[],
  orderDiscount: string,
): { subtotalUnits: bigint; discountUnits: bigint; taxUnits: bigint; totalUnits: bigint } {
  const lineValues = lines.map((line) => {
    const gross = multiplyToMoneyUnits(decimalToUnits(line.quantity), decimalToUnits(line.unitPrice));
    const discount = decimalToUnits(line.lineDiscount);
    if (discount > gross) throw new Error("Line discount cannot exceed line value");
    return { gross, discount, taxable: gross - discount, rate: line.taxRate };
  });
  const subtotalUnits = lineValues.reduce((sum, line) => sum + line.gross, 0n);
  const lineDiscountUnits = lineValues.reduce((sum, line) => sum + line.discount, 0n);
  const orderDiscountUnits = decimalToUnits(orderDiscount);
  const taxableTotal = lineValues.reduce((sum, line) => sum + line.taxable, 0n);
  if (lineDiscountUnits + orderDiscountUnits > subtotalUnits) {
    throw new Error("Discounts cannot exceed the subtotal");
  }
  const orderAllocations = allocateProportionally(orderDiscountUnits, lineValues.map((line) => line.taxable));
  const taxUnits = lineValues.reduce(
    (sum, line, index) => sum + taxForAmount(line.taxable - orderAllocations[index]!, line.rate),
    0n,
  );
  return {
    subtotalUnits,
    discountUnits: lineDiscountUnits + orderDiscountUnits,
    taxUnits,
    totalUnits: subtotalUnits - lineDiscountUnits - orderDiscountUnits + taxUnits,
  };
}
