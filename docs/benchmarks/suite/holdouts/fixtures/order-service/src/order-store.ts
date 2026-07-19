import type { CheckoutOrder } from './order-route.js'

export async function saveOrder(order: CheckoutOrder, reservation: string): Promise<CheckoutOrder> {
  void reservation
  return order
}
