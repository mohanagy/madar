import { describe, expect, it } from 'vitest'

import { generateInvoice } from '../../src/invoices/invoice-generation-service.js'

describe('generateInvoice', () => {
  it('keeps retry logic behind the service workflow owner', () => {
    expect(generateInvoice('inv-1')).toEqual({ invoiceId: 'inv-1', retried: true })
  })
})
