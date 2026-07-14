import { reserveInventory } from './inventory.js'
import { saveOrder } from './order-store.js'
import { publishOrderConfirmed } from './publisher.js'

export interface CheckoutOrder {
  id: string
  sku: string
  quantity: number
}

export async function submitOrder(order: CheckoutOrder): Promise<void> {
  const reservation = await reserveInventory(order.sku, order.quantity)
  const savedOrder = await saveOrder(order, reservation)
  await publishOrderConfirmed(savedOrder.id)
}
