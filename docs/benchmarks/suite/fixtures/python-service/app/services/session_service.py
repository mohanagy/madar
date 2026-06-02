from app.audit import AuditLog
from app.repositories.session_repository import SessionRecord, SessionRepository


class SessionService:
    def __init__(self, repository: SessionRepository, audit_log: AuditLog) -> None:
        self.repository = repository
        self.audit_log = audit_log

    def create_login_session(self, user_id: str, device_id: str) -> SessionRecord:
        session = self.repository.create_login_session(user_id=user_id, device_id=device_id)
        self.audit_log.record_login_session(user_id=user_id, session_id=session.session_id)
        return session


_default_repository = SessionRepository()
_default_audit_log = AuditLog()


def get_session_service() -> SessionService:
    return SessionService(repository=_default_repository, audit_log=_default_audit_log)
