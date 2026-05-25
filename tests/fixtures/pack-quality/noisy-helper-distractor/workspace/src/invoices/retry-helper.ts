export function retryWhenInvoiceGenerationFails(invoiceId: string) {
  return { invoiceId, retried: true }
}
