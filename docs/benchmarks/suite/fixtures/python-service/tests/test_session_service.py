from app.audit import AuditLog
from app.repositories.session_repository import SessionRepository
from app.services.session_service import SessionService


def test_create_login_session_records_an_audit_event() -> None:
    audit_log = AuditLog()
    service = SessionService(repository=SessionRepository(), audit_log=audit_log)

    session = service.create_login_session(user_id="u-123", device_id="web")

    assert session.session_id == "u-123:web"
    assert audit_log.events == [{
        "event": "login_session_created",
        "user_id": "u-123",
        "session_id": "u-123:web",
    }]
