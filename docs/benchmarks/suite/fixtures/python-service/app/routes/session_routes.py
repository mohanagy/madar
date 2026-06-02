from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.services.session_service import SessionService, get_session_service

router = APIRouter(prefix="/login", tags=["session"])


class LoginSessionRequest(BaseModel):
    user_id: str
    device_id: str


class LoginSessionResponse(BaseModel):
    session_id: str
    audit_event: str


@router.post("/session", response_model=LoginSessionResponse)
def create_login_session(
    request: LoginSessionRequest,
    service: SessionService = Depends(get_session_service),
) -> LoginSessionResponse:
    session = service.create_login_session(user_id=request.user_id, device_id=request.device_id)
    return LoginSessionResponse(session_id=session.session_id, audit_event="login_session_created")
