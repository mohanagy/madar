class AuditLog:
    def __init__(self) -> None:
        self.events: list[dict[str, str]] = []

    def record_login_session(self, user_id: str, session_id: str) -> None:
        self.events.append({
            "event": "login_session_created",
            "user_id": user_id,
            "session_id": session_id,
        })
