# Python service benchmark fixture

This fixture is a small FastAPI-style login session service used by the public benchmark suite.

Primary flow:

- `app/routes/session_routes.py` receives the login session request
- `app/services/session_service.py` creates the session and records audit evidence
- `app/repositories/session_repository.py` persists the session-shaped record
- `app/audit.py` captures the login-session audit event

The suite prompts for this fixture focus on explain, implement, review, and impact questions around the same bounded session-creation path.
