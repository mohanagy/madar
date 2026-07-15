from service import issue_invoice


def create_invoice(customer_id: str, subtotal: int) -> dict:
    return issue_invoice(customer_id, subtotal)
