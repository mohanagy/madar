import { retryWhenInvoiceGenerationFails } from './retry-helper.js'

export function generateInvoice(invoiceId: string) {
  return retryWhenInvoiceGenerationFails(invoiceId)
}
