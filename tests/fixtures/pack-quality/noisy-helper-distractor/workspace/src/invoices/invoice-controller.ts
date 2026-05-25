import { generateInvoice } from './invoice-generation-service.js'

export function submitInvoiceRetry(invoiceId: string) {
  return generateInvoice(invoiceId)
}
