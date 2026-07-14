def record_invoice(customer_id: str, total: int) -> dict:
    return {"id": f"invoice:{customer_id}", "customer_id": customer_id, "total": total}
