from dataclasses import dataclass


@dataclass(frozen=True)
class SessionRecord:
    session_id: str
    user_id: str
    device_id: str


class SessionRepository:
    def create_login_session(self, user_id: str, device_id: str) -> SessionRecord:
        return SessionRecord(
            session_id=f"{user_id}:{device_id}",
            user_id=user_id,
            device_id=device_id,
        )
