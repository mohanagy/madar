from audit import emit_invoice_created
from ledger import record_invoice


def calculate_total(subtotal: int) -> int:
    return subtotal + (subtotal // 10)


def issue_invoice(customer_id: str, subtotal: int) -> dict:
    total = calculate_total(subtotal)
    invoice = record_invoice(customer_id, total)
    emit_invoice_created(invoice["id"])
    return invoice
