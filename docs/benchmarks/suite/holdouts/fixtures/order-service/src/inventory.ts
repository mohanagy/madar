export async function reserveInventory(sku: string, quantity: number): Promise<string> {
  return `reservation:${sku}:${quantity}`
}
